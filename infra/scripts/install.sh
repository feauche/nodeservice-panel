#!/usr/bin/env bash
# NodeService — установка панели на чистый Ubuntu/Debian VPS одной командой.
#
#   bash <(curl -fsSL https://raw.githubusercontent.com/feauche/nodeservice-panel/main/infra/scripts/install.sh)
#
# Переезд/восстановление на чистом сервере из бэкапа (nodeservice backup):
#   bash <(curl -fsSL …/install.sh) --restore /root/nodeservice-backup-<время>.tar.gz
# — секреты и данные берутся из бэкапа, домен по умолчанию прежний; потом переключи DNS.
#
# Ставит Docker, клонирует репозиторий в /opt/nodeservice (для приватного — по deploy-ключу),
# генерирует infra/.env с секретами, собирает образ api из исходников, поднимает стек
# (Caddy + api + Postgres + Valkey + VictoriaMetrics), ставит команду `nodeservice`, ежедневный
# бэкап БД и печатает токен первого запуска. Повторный запуск безопасен: .env и данные не трогает.
set -euo pipefail

REPO_SSH="${NODESERVICE_REPO_SSH:-git@github.com:feauche/nodeservice-panel.git}"
REPO_HTTPS="${NODESERVICE_REPO_HTTPS:-https://github.com/feauche/nodeservice-panel.git}"
BRANCH="${NODESERVICE_BRANCH:-main}"
APP_DIR="${NODESERVICE_DIR:-/opt/nodeservice}"
export NODESERVICE_DIR="$APP_DIR"
DEPLOY_KEY="/root/.ssh/nodeservice_deploy"
ENV_FILE="$APP_DIR/infra/.env"
export GIT_TERMINAL_PROMPT=0
COMPOSE=(docker compose -f "$APP_DIR/infra/compose.yaml" --env-file "$ENV_FILE")

RESTORE_FILE=""
while [[ $# -gt 0 ]]; do
    case "$1" in
        --restore) RESTORE_FILE="${2:-}"; shift 2 ;;
        -h|--help) sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *) echo "Неизвестный параметр: $1 (поддерживается --restore <файл бэкапа>)" >&2; exit 1 ;;
    esac
done

C='\033[0;36m'; G='\033[0;32m'; Y='\033[1;33m'; R='\033[1;31m'; N='\033[0m'
step() { echo -e "\n${C}==> $1${N}"; }
ok()   { echo -e "${G}[+] $1${N}"; }
info() { echo -e "[i] $1"; }
warn() { echo -e "${Y}[!] $1${N}"; }
die()  { echo -e "${R}[-] $1${N}" >&2; exit 1; }
ask()  { local p="$1" d="${2:-}" a; read -rp "$p${d:+ [$d]}: " a </dev/tty; printf '%s' "${a:-$d}"; }

# Ждёт healthy у api до ~3 минут; при провале печатает лог и завершает скрипт.
wait_api_healthy() {
    local st=starting
    for _ in $(seq 1 60); do
        st=$(docker inspect -f '{{.State.Health.Status}}' nodeservice-api-1 2>/dev/null || echo starting)
        [[ "$st" == "healthy" ]] && return 0
        sleep 3
    done
    "${COMPOSE[@]}" logs --tail=80 api || true
    die "api не стал healthy (статус: $st) — лог выше."
}

[[ $EUID -eq 0 ]] || die "Запусти от root."
command -v apt-get >/dev/null || die "Поддерживаются только Debian/Ubuntu."
[[ -d "$APP_DIR/.git" ]] && info "Найдена установка в $APP_DIR — режим повторного запуска. Обычное обновление: nodeservice update"

# --- 0. Параметры ---------------------------------------------------------------------------
step "Параметры"
RESTORE_ENV=""
if [[ -n "$RESTORE_FILE" ]]; then
    [[ -f "$RESTORE_FILE" ]] || die "Файл бэкапа не найден: $RESTORE_FILE"
    RESTORE_FILE=$(readlink -f "$RESTORE_FILE")
    [[ -f "$ENV_FILE" ]] && die "Панель уже установлена в $APP_DIR. Восстановление поверх: nodeservice restore $RESTORE_FILE"
    RESTORE_WORK=$(mktemp -d /tmp/nodeservice-restore-env.XXXXXX); chmod 700 "$RESTORE_WORK"
    tar -C "$RESTORE_WORK" -xzf "$RESTORE_FILE" env meta 2>/dev/null || die "Это не бэкап панели (ожидается nodeservice-backup-*.tar.gz от nodeservice backup)."
    RESTORE_ENV="$RESTORE_WORK/env"
    [[ -f "$RESTORE_WORK/meta" ]] && { info "Бэкап:"; sed 's/^/     /' "$RESTORE_WORK/meta"; }
    # Домен по умолчанию — прежний: тогда агенты на нодах подключатся к новой панели сами.
    old_domain=$(grep -E '^PANEL_DOMAIN=' "$RESTORE_ENV" | cut -d= -f2- || true)
    old_email=$(grep -E '^ACME_EMAIL=' "$RESTORE_ENV" | cut -d= -f2- || true)
    PANEL_DOMAIN=$(ask "Домен панели (прежний — агенты на нодах переподключатся сами)" "${old_domain:-}")
    [[ "$PANEL_DOMAIN" =~ ^[a-z0-9.-]+\.[a-z]{2,}$ ]] || die "Некорректный домен: '$PANEL_DOMAIN'"
    [[ -n "$old_domain" && "$PANEL_DOMAIN" != "$old_domain" ]] && warn "Домен меняется: агентам на нодах нужно будет переустановиться (Серверы → Установить агента)."
    ACME_EMAIL=$(ask "E-mail для Let's Encrypt" "${old_email:-admin@${PANEL_DOMAIN#*.}}")
elif [[ -f "$ENV_FILE" ]]; then
    # shellcheck disable=SC1090
    source "$ENV_FILE"
    ok "infra/.env уже есть: домен ${PANEL_DOMAIN:-?}, секреты сохраняются."
else
    PANEL_DOMAIN=$(ask "Домен панели (A-запись должна указывать на этот сервер)")
    [[ "$PANEL_DOMAIN" =~ ^[a-z0-9.-]+\.[a-z]{2,}$ ]] || die "Некорректный домен: '$PANEL_DOMAIN'"
    ACME_EMAIL=$(ask "E-mail для Let's Encrypt" "admin@${PANEL_DOMAIN#*.}")
fi

# DNS: домен обязан резолвиться в публичный адрес этого сервера, иначе сертификат не выпустится.
PUBLIC_IP=$(curl -fsS4 --max-time 8 https://api.ipify.org 2>/dev/null || true)
RESOLVED=$(getent ahostsv4 "$PANEL_DOMAIN" 2>/dev/null | awk '{print $1}' | sort -u | tr '\n' ' ' || true)
if [[ -n "$PUBLIC_IP" && "$RESOLVED" == *"$PUBLIC_IP"* ]]; then
    ok "DNS: $PANEL_DOMAIN → $PUBLIC_IP"
else
    warn "DNS: $PANEL_DOMAIN резолвится в '${RESOLVED:-ничего}', публичный IP сервера — '${PUBLIC_IP:-?}'."
    warn "Без правильной A-записи Caddy не получит сертификат. Продолжаю, но проверь DNS."
fi

# --- 1. Docker ------------------------------------------------------------------------------
step "Docker"
apt-get update -qq
apt-get install -y -qq ca-certificates curl git openssl >/dev/null
if ! command -v docker >/dev/null || ! docker compose version >/dev/null 2>&1; then
    info "Ставлю Docker Engine + compose plugin (get.docker.com)..."
    curl -fsSL https://get.docker.com -o /tmp/get-docker.sh || die "Не скачался get.docker.com — проверь сеть."
    sh /tmp/get-docker.sh >/dev/null
    rm -f /tmp/get-docker.sh
    systemctl enable --now docker >/dev/null
fi
ok "Docker $(docker --version | awk '{print $3}' | tr -d ,), compose $(docker compose version --short)"

# Сборка образа на сервере (pnpm install + vite + nest build): при < 3.5 ГБ RAM+swap падает по OOM.
MEM_MB=$(awk '/MemTotal/ {print int($2/1024)}' /proc/meminfo)
SWAP_MB=$(awk '/SwapTotal/ {print int($2/1024)}' /proc/meminfo)
if (( MEM_MB + SWAP_MB < 3500 )) && [[ ! -f /swapfile ]]; then
    info "RAM ${MEM_MB} МБ — добавляю swap 2 ГБ для сборки..."
    if fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile >/dev/null && swapon /swapfile; then
        grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
        ok "Swap включён."
    else
        rm -f /swapfile
        warn "Swap создать не удалось — сборка образа может упасть по нехватке памяти."
    fi
fi

# --- 2. Исходники (приватный репозиторий → deploy-ключ) -------------------------------------
step "Исходники"
if [[ ! -d "$APP_DIR/.git" ]]; then
    if GIT_TERMINAL_PROMPT=0 git ls-remote --quiet "$REPO_HTTPS" >/dev/null 2>&1; then
        git clone --branch "$BRANCH" --depth 1 "$REPO_HTTPS" "$APP_DIR"
    else
        mkdir -p -m 700 /root/.ssh
        [[ -f "$DEPLOY_KEY" ]] || ssh-keygen -t ed25519 -N '' -C "nodeservice-deploy@$(hostname)" -f "$DEPLOY_KEY" >/dev/null
        echo ""
        warn "Репозиторий приватный. Добавь этот публичный ключ как Deploy key (только чтение):"
        echo -e "   ${C}https://github.com/feauche/nodeservice-panel/settings/keys/new${N}"
        echo ""
        cat "${DEPLOY_KEY}.pub"
        echo ""
        read -rp "Добавил ключ — нажми Enter, чтобы продолжить... " _ </dev/tty
        ssh-keyscan -t ed25519 github.com >> /root/.ssh/known_hosts 2>/dev/null || true
        export GIT_SSH_COMMAND="ssh -i $DEPLOY_KEY -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new"
        git clone --branch "$BRANCH" --depth 1 "$REPO_SSH" "$APP_DIR" || die "Клонирование не удалось: проверь, что ключ добавлен."
    fi
else
    # Повторный запуск (например, после неудачной сборки): подтягиваем свежий код ветки.
    [[ -f "$DEPLOY_KEY" ]] && export GIT_SSH_COMMAND="ssh -i $DEPLOY_KEY -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new"
    if git -C "$APP_DIR" fetch --quiet --depth 1 origin "$BRANCH" && git -C "$APP_DIR" checkout --quiet --detach FETCH_HEAD; then
        info "Код обновлён до последнего коммита ветки $BRANCH."
        [[ -f "$ENV_FILE" ]] && sed -i "s/^NODESERVICE_VERSION=.*/NODESERVICE_VERSION=$(git -C "$APP_DIR" rev-parse --short HEAD)/" "$ENV_FILE"
    else
        warn "Не удалось обновить код — продолжаю с тем, что есть в $APP_DIR."
    fi
fi
ok "Код в $APP_DIR ($(git -C "$APP_DIR" rev-parse --short HEAD))"

# --- 3. .env с секретами --------------------------------------------------------------------
step "Конфигурация"
envval() { grep -E "^$2=" "$1" 2>/dev/null | head -1 | cut -d= -f2- || true; }
if [[ -n "$RESTORE_ENV" ]]; then
    # Секреты — из бэкапа (иначе TOTP, доступы к серверам и ключ панели не расшифровать),
    # домен/e-mail — что выбрали выше, версия кода — текущая.
    umask 077
    cat > "$ENV_FILE" <<ENV
# Восстановлено install.sh --restore $(date -u +%Y-%m-%dT%H:%MZ) из $(basename "$RESTORE_FILE"). Не коммитить.
# Бэкапь вместе с БД — без ENCRYPTION_KEY зашифрованные секреты не восстановить.
PANEL_DOMAIN=${PANEL_DOMAIN}
ACME_EMAIL=${ACME_EMAIL}
NODESERVICE_VERSION=$(git -C "$APP_DIR" rev-parse --short HEAD)
POSTGRES_PASSWORD=$(envval "$RESTORE_ENV" POSTGRES_PASSWORD)
APP_SECRET=$(envval "$RESTORE_ENV" APP_SECRET)
ENCRYPTION_KEY=$(envval "$RESTORE_ENV" ENCRYPTION_KEY)
ENCRYPTION_KEY_VERSION=$(envval "$RESTORE_ENV" ENCRYPTION_KEY_VERSION)
PASSWORD_PEPPER=$(envval "$RESTORE_ENV" PASSWORD_PEPPER)
ENV
    umask 022
    for k in POSTGRES_PASSWORD APP_SECRET ENCRYPTION_KEY; do
        [[ -n "$(envval "$ENV_FILE" $k)" ]] || die "В бэкапе нет $k — .env в архиве неполный."
    done
    # Прочие переменные из старого .env (например, PROVIDER_ICON_FALLBACK_URL) переносим как есть.
    grep -vE '^(#|$|PANEL_DOMAIN=|ACME_EMAIL=|NODESERVICE_VERSION=|POSTGRES_PASSWORD=|APP_SECRET=|ENCRYPTION_KEY=|ENCRYPTION_KEY_VERSION=|PASSWORD_PEPPER=)' "$RESTORE_ENV" >> "$ENV_FILE" || true
    rm -rf "$RESTORE_WORK"
    ok "infra/.env восстановлен из бэкапа (домен $PANEL_DOMAIN)."
elif [[ ! -f "$ENV_FILE" ]]; then
    umask 077
    cat > "$ENV_FILE" <<ENV
# Сгенерировано install.sh $(date -u +%Y-%m-%dT%H:%MZ). Не коммитить. Бэкапь вместе с БД —
# без ENCRYPTION_KEY зашифрованные секреты (TOTP, доступы к серверам) не восстановить.
PANEL_DOMAIN=${PANEL_DOMAIN}
ACME_EMAIL=${ACME_EMAIL}
NODESERVICE_VERSION=$(git -C "$APP_DIR" rev-parse --short HEAD)
POSTGRES_PASSWORD=$(openssl rand -hex 24)
APP_SECRET=$(openssl rand -hex 32)
ENCRYPTION_KEY=$(openssl rand -hex 32)
ENCRYPTION_KEY_VERSION=1
PASSWORD_PEPPER=$(openssl rand -hex 32)
ENV
    umask 022
    ok "infra/.env создан (секреты сгенерированы, права 600)."
fi

# --- 4. Firewall ----------------------------------------------------------------------------
if command -v ufw >/dev/null && ufw status 2>/dev/null | grep -q "Status: active"; then
    ufw allow 80/tcp comment 'nodeservice http' >/dev/null 2>&1 || true
    ufw allow 443/tcp comment 'nodeservice https' >/dev/null 2>&1 || true
    ufw allow 443/udp comment 'nodeservice h3' >/dev/null 2>&1 || true
    ok "UFW: открыты 80/tcp, 443/tcp, 443/udp."
fi

# --- 5. Сборка и запуск ---------------------------------------------------------------------
step "Сборка образа api (первый раз 3–8 минут)"
"${COMPOSE[@]}" build api || die "Сборка образа не удалась — лог выше."
step "Запуск стека"
# caddy ждёт healthy у api через depends_on; при провале `up -d` сам вернёт ошибку без логов,
# поэтому код возврата игнорируем и диагностируем сами в wait_api_healthy.
"${COMPOSE[@]}" up -d --remove-orphans || true
info "Жду, пока api станет healthy..."
wait_api_healthy
ok "Стек запущен."

# --- 6. Команда nodeservice + бэкапы --------------------------------------------------------
step "Обслуживание"
install -m 0755 "$APP_DIR/infra/scripts/nodeservice" /usr/local/bin/nodeservice
mkdir -p -m 700 "$APP_DIR/backups"
cat > /etc/cron.d/nodeservice-backup <<CRON
# Ежедневный полный бэкап NodeService: БД + .env одним архивом (хранится 14 дней) — infra/scripts/backup.sh
17 3 * * * root NODESERVICE_DIR="$APP_DIR" /usr/local/bin/nodeservice backup >> /var/log/nodeservice-backup.log 2>&1
CRON
ok "Команда nodeservice установлена; бэкап ежедневно в 03:17 → $APP_DIR/backups"

# --- 7. Восстановление из бэкапа ------------------------------------------------------------
if [[ -n "$RESTORE_FILE" ]]; then
    step "Восстановление данных из бэкапа"
    bash "$APP_DIR/infra/scripts/restore.sh" "$RESTORE_FILE" --yes || die "Восстановление не удалось — лог выше. Стек запущен с пустой БД."
    step "Готово"
    echo -e "Панель восстановлена: ${G}https://${PANEL_DOMAIN}${N} — вход прежним паролем и кодом из приложения."
    echo "Переключи A-запись $PANEL_DOMAIN на этот сервер; сертификат выпустится сам, агенты на нодах переподключатся."
    echo ""
    echo "Команды: nodeservice status | logs | update | rollback | backup | restore <файл> | cli <команда>"
    exit 0
fi

# --- 8. Токен первого запуска ---------------------------------------------------------------
step "Готово"
echo -e "Панель: ${G}https://${PANEL_DOMAIN}${N} (сертификат выпускается ~30 с после первого запроса)"
echo ""
set +e
cli_out=$("${COMPOSE[@]}" exec -T api node dist/cli.js setup-token 2>&1); cli_rc=$?
set -e
if [[ $cli_rc -eq 0 ]]; then
    echo "$cli_out"
elif grep -q "уже создан" <<<"$cli_out"; then
    info "Администратор уже создан — токен не нужен. Сброс пароля: nodeservice cli reset-password"
else
    warn "Не удалось выпустить токен первого запуска:"
    echo "$cli_out"
    warn "Повтори позже: nodeservice cli setup-token"
fi
echo ""
echo "Команды: nodeservice status | logs | update | rollback | backup | restore <файл> | cli <команда>"
