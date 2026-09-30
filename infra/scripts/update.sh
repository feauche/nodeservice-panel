#!/usr/bin/env bash
# Обновление панели: бэкап → git fetch → сборка нового образа api → замена с сохранением
# предыдущего образа для отката (nodeservice rollback). Миграции применяет сам api при старте.
# После удачного обновления прежние образы панели, кроме текущего и отката, удаляются с диска.

# Образ api получает тег по коммиту, поэтому каждое обновление оставляло на диске прежний образ (сотни МБ):
# `docker image prune` убирает только образы без тега, и диск сервера панели постепенно заполнялся.
# После удачного обновления оставляем два образа — текущий и точку отката (nodeservice-api:prev).
#
# stale_api_images — какие образы удалить. stdin: строки «ID репозиторий:тег», как их печатает
# `docker images --no-trunc --format '{{.ID}} {{.Repository}}:{{.Tag}}'`; $1 — ID текущего образа,
# $2 — ID образа отката (пусто, если его нет). stdout: теги на удаление, по одному в строке.
# Сравнение по ID: у образа отката остаётся и прежний тег по коммиту — он указывает на тот же образ.
# Текущий образ неизвестен или его нет в списке (значит, список читается не так, как мы думаем) — не
# удаляем ничего: лучше лишние гигабайты, чем панель без образа или без точки отката.
stale_api_images() {
    local cur_id="${1:-}" prev_id="${2:-}" list id ref seen=""
    [[ -n "$cur_id" ]] || return 0
    list=$(cat)
    while read -r id ref; do
        if [[ "$id" == "$cur_id" ]]; then seen=1; fi
    done <<<"$list"
    [[ -n "$seen" ]] || return 0
    while read -r id ref; do
        [[ -n "$id" && -n "$ref" ]] || continue
        # Образ без тега по имени не удалить — такие убирает `docker image prune`.
        [[ "$ref" == *"<none>"* ]] && continue
        [[ "$id" == "$cur_id" || "$id" == "$prev_id" ]] && continue
        printf '%s\n' "$ref"
    done <<<"$list"
    return 0
}

# Чистка после удачного обновления: прежние образы панели (кроме текущего и отката), образы без тега и кэш
# сборки старше недели — свежий кэш остаётся, чтобы следующая сборка шла быстро. Ошибка чистки обновление
# неудачным не делает: всё под `|| true`. Берёт COMPOSE и цвета сообщений из основной части скрипта.
cleanup_old_images() {
    local cur repo cur_id="" prev_id list="" stale="" ref removed=0
    cur=$("${COMPOSE[@]}" config --images 2>/dev/null | grep nodeservice-api || true)
    repo="${cur%:*}"
    if [[ -n "$cur" ]]; then
        cur_id=$(docker image inspect -f '{{.Id}}' "$cur" 2>/dev/null || true)
        list=$(docker images --no-trunc --format '{{.ID}} {{.Repository}}:{{.Tag}}' "$repo" 2>/dev/null || true)
    fi
    prev_id=$(docker image inspect -f '{{.Id}}' nodeservice-api:prev 2>/dev/null || true)
    if [[ -z "$cur_id" || $'\n'"$list" != *$'\n'"$cur_id "* ]]; then
        # Молча пропускать нельзя: иначе диск снова начнёт заполняться, и этого никто не заметит.
        echo -e "${Y:-}Прежние версии панели не удаляю: не удалось определить текущий образ.${N:-}"
    else
        stale=$(stale_api_images "$cur_id" "$prev_id" <<<"$list" || true)
        while IFS= read -r ref; do
            [[ -n "$ref" ]] || continue
            if docker rmi "$ref" >/dev/null 2>&1; then removed=$((removed + 1)); fi
        done <<<"$stale"
    fi
    docker image prune -f >/dev/null 2>&1 || true
    docker builder prune -f --filter until=168h >/dev/null 2>&1 || true
    if (( removed > 0 )); then echo -e "${G:-}Удалено прежних версий панели с диска: $removed.${N:-}"; fi
    return 0
}

# Проверка функций без обновления: `NODESERVICE_UPDATE_LIB=1 source update.sh` — только определения выше,
# без настроек оболочки и переменных (COMPOSE для cleanup_old_images тогда задаёт сам проверяющий).
if [[ -n "${NODESERVICE_UPDATE_LIB:-}" ]]; then return 0 2>/dev/null || exit 0; fi

set -euo pipefail
APP_DIR="${NODESERVICE_DIR:-/opt/nodeservice}"
export NODESERVICE_DIR="$APP_DIR"
ENV_FILE="$APP_DIR/infra/.env"
COMPOSE=(docker compose -f "$APP_DIR/infra/compose.yaml" --env-file "$ENV_FILE")
REF="${1:-main}"
G='\033[0;32m'; C='\033[0;36m'; Y='\033[1;33m'; R='\033[1;31m'; N='\033[0m'
die() { echo -e "${R}[-] $1${N}" >&2; exit 1; }
[[ -d "$APP_DIR/.git" ]] || die "Нет git-репозитория в $APP_DIR."

DEPLOY_KEY="/root/.ssh/nodeservice_deploy"
REPO_SSH="${NODESERVICE_REPO_SSH:-git@github.com:feauche/nodeservice-panel.git}"
export GIT_TERMINAL_PROMPT=0
[[ -f "$DEPLOY_KEY" ]] && export GIT_SSH_COMMAND="ssh -i $DEPLOY_KEY -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new"

# Репозиторий клонировали по HTTPS (был публичным), а теперь он приватный: переводим origin на
# SSH с deploy-ключом, как это делает install.sh.
switch_to_deploy_key() {
    mkdir -p -m 700 /root/.ssh
    [[ -f "$DEPLOY_KEY" ]] || ssh-keygen -t ed25519 -N '' -C "nodeservice-deploy@$(hostname)" -f "$DEPLOY_KEY" >/dev/null
    echo ""
    echo -e "${Y}Похоже, репозиторий стал приватным. Добавь этот ключ как Deploy key (только чтение):${N}"
    echo -e "   ${C}https://github.com/feauche/nodeservice-panel/settings/keys/new${N}"
    echo ""
    cat "${DEPLOY_KEY}.pub"
    echo ""
    read -rp "Добавил ключ — нажми Enter, чтобы продолжить... " _ </dev/tty
    ssh-keyscan -t ed25519 github.com >> /root/.ssh/known_hosts 2>/dev/null || true
    export GIT_SSH_COMMAND="ssh -i $DEPLOY_KEY -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new"
    git remote set-url origin "$REPO_SSH"
}

cd "$APP_DIR"
# Текущий образ запоминаем ДО смены кода и версии — он и есть точка отката.
OLD_IMG=$("${COMPOSE[@]}" config --images | grep nodeservice-api || true)
# Только если api с этим образом сейчас здоров: иначе повторный update после неудачного запомнил бы
# сломанный образ, и rollback вернул бы его же.
api_health=$(docker inspect -f '{{.State.Health.Status}}' nodeservice-api-1 2>/dev/null || echo none)
if [[ -n "$OLD_IMG" ]] && docker image inspect "$OLD_IMG" >/dev/null 2>&1 && [[ "$api_health" == "healthy" ]]; then
    docker tag "$OLD_IMG" nodeservice-api:prev
elif [[ -n "$OLD_IMG" ]]; then
    echo -e "${Y}api сейчас не работает ($api_health) — точку отката оставляю прежней.${N}"
fi

if [[ -n "$(git status --porcelain --untracked-files=no)" ]]; then
    git status --short --untracked-files=no
    die "В $APP_DIR есть локальные правки отслеживаемых файлов (выше). Убери их (git stash / git checkout -- .) и повтори."
fi

before=$(git rev-parse --short HEAD)
echo -e "${C}==> Код: $before → $REF${N}"
if ! git fetch --all --tags --prune --quiet; then
    if [[ "$(git remote get-url origin)" == https://* ]]; then
        switch_to_deploy_key
        git fetch --all --tags --prune --quiet || die "git fetch не удался и по deploy-ключу — проверь, что ключ добавлен."
    else
        die "git fetch не удался — проверь сеть и deploy-ключ."
    fi
fi
# Сначала ветка на origin (локальная могла устареть), потом тег/commit.
if git rev-parse --verify --quiet "origin/$REF" >/dev/null; then
    git checkout --quiet --detach "origin/$REF"
elif git rev-parse --verify --quiet "$REF^{commit}" >/dev/null; then
    git checkout --quiet --detach "$REF"
else
    die "Не нашёл '$REF' (ветка на origin, тег или commit)."
fi
after=$(git rev-parse --short HEAD)

# Бэкап перед обновлением — на случай неудачной миграции. Выключается в панели
# («Резервные копии → Копия перед обновлением»): тогда панель кладёт метку .skip-before-update.
mkdir -p -m 700 "$APP_DIR/backups"; chown 10001:10001 "$APP_DIR/backups" 2>/dev/null || true
rm -f /etc/cron.d/nodeservice-backup
# Копию делает сама панель — по настройкам из «Резервных копий» (пароль, метрики, папки, Telegram, проверка).
# Не ответила (не запущена, старая версия, копия уже идёт) — консольная копия, как раньше: БД + .env.
panel_backup() {
    "${COMPOSE[@]}" exec -T api node -e '
const sig = require("node:crypto").createHmac("sha256", process.env.APP_SECRET)
  .update("nodeservice-internal:backup:pre_update").digest("hex");
fetch("http://127.0.0.1:" + (process.env.PORT || 3000) + "/api/internal/backups/pre-update",
  { method: "POST", headers: { "x-nodeservice-internal": sig } })
  .then(async (r) => {
    const b = await r.json().catch(() => ({}));
    if (!r.ok) { console.error(b.detail || ("код " + r.status)); process.exit(1); }
    console.log(b.name + " (" + (b.size / 1048576).toFixed(1) + " МБ" + (b.encrypted ? ", с паролем" : "") + ")");
  })
  .catch((e) => { console.error(e.message); process.exit(1); });' 2>&1
}
if [[ -f "$APP_DIR/backups/.skip-before-update" ]]; then
    echo -e "${Y}Копия перед обновлением выключена в панели — пропускаю.${N}"
elif out=$(panel_backup); then
    echo -e "${G}Копия панели перед обновлением: $out${N}"
else
    echo -e "${Y}Панель не сделала копию (${out:-нет ответа}) — делаю консольную: БД + .env.${N}"
    bash "$APP_DIR/infra/scripts/backup.sh"
fi

echo -e "${C}==> Сборка образа api ($after)${N}"
sed -i "s/^NODESERVICE_VERSION=.*/NODESERVICE_VERSION=$after/" "$ENV_FILE"
export APP_COMMIT="$after" APP_BUILT_AT="$(date -u +%Y-%m-%d)"
if ! "${COMPOSE[@]}" build api; then
    sed -i "s/^NODESERVICE_VERSION=.*/NODESERVICE_VERSION=$before/" "$ENV_FILE"
    git checkout --quiet --detach "$before"
    die "Сборка не удалась. Старая версия $before продолжает работать, код возвращён на неё."
fi
echo -e "${C}==> Перезапуск${N}"
"${COMPOSE[@]}" up -d --remove-orphans || true
st=starting
for _ in $(seq 1 60); do
    st=$(docker inspect -f '{{.State.Health.Status}}' nodeservice-api-1 2>/dev/null || echo starting)
    [[ "$st" == "healthy" ]] && break
    sleep 3
done
if [[ "$st" != "healthy" ]]; then
    "${COMPOSE[@]}" logs --tail=80 api || true
    echo -e "${Y}api не поднялся после обновления (статус: $st).${N}"
    die "Откат на предыдущий образ: nodeservice rollback"
fi
cleanup_old_images || true
echo -e "${G}Обновлено: $before → $after.${N} Откат при необходимости: nodeservice rollback"
