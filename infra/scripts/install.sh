#!/usr/bin/env bash
# NodeService — установка панели на чистый Ubuntu/Debian VPS одной командой.
#
#   bash <(curl -fsSL https://raw.githubusercontent.com/feauche/nodeservice-panel/main/infra/scripts/install.sh)
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
COMPOSE=(docker compose -f "$APP_DIR/infra/compose.yaml" --env-file "$ENV_FILE")

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
if [[ -f "$ENV_FILE" ]]; then
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
    fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile >/dev/null && swapon /swapfile
    grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
    ok "Swap включён."
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
        ssh-keyscan -t ed25519 github.com >> /root/.ssh/known_hosts 2>/dev/null
        export GIT_SSH_COMMAND="ssh -i $DEPLOY_KEY -o IdentitiesOnly=yes"
        git clone --branch "$BRANCH" --depth 1 "$REPO_SSH" "$APP_DIR" || die "Клонирование не удалось: проверь, что ключ добавлен."
    fi
fi
ok "Код в $APP_DIR ($(git -C "$APP_DIR" rev-parse --short HEAD))"

# --- 3. .env с секретами --------------------------------------------------------------------
step "Конфигурация"
if [[ ! -f "$ENV_FILE" ]]; then
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
# Ежедневный бэкап БД NodeService (хранится 14 дней) — infra/scripts/backup.sh
17 3 * * * root NODESERVICE_DIR=$APP_DIR /usr/local/bin/nodeservice backup >> /var/log/nodeservice-backup.log 2>&1
CRON
ok "Команда nodeservice установлена; бэкап БД ежедневно в 03:17 → $APP_DIR/backups"

# --- 7. Токен первого запуска ---------------------------------------------------------------
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
