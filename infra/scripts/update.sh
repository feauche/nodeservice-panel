#!/usr/bin/env bash
# Обновление панели: бэкап → git fetch → сборка нового образа api → замена с сохранением
# предыдущего образа для отката (nodeservice rollback). Миграции применяет сам api при старте.
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
[[ -f "$DEPLOY_KEY" ]] && export GIT_SSH_COMMAND="ssh -i $DEPLOY_KEY -o IdentitiesOnly=yes"

cd "$APP_DIR"
# Текущий образ запоминаем ДО смены кода и версии — он и есть точка отката.
OLD_IMG=$("${COMPOSE[@]}" config --images | grep nodeservice-api || true)
if [[ -n "$OLD_IMG" ]] && docker image inspect "$OLD_IMG" >/dev/null 2>&1; then
    docker tag "$OLD_IMG" nodeservice-api:prev
fi

if [[ -n "$(git status --porcelain --untracked-files=no)" ]]; then
    git status --short --untracked-files=no
    die "В $APP_DIR есть локальные правки отслеживаемых файлов (выше). Убери их (git stash / git checkout -- .) и повтори."
fi

before=$(git rev-parse --short HEAD)
echo -e "${C}==> Код: $before → $REF${N}"
git fetch --all --tags --prune --quiet || die "git fetch не удался — проверь сеть и deploy-ключ."
# Сначала ветка на origin (локальная могла устареть), потом тег/commit.
if git rev-parse --verify --quiet "origin/$REF" >/dev/null; then
    git checkout --quiet --detach "origin/$REF"
elif git rev-parse --verify --quiet "$REF^{commit}" >/dev/null; then
    git checkout --quiet --detach "$REF"
else
    die "Не нашёл '$REF' (ветка на origin, тег или commit)."
fi
after=$(git rev-parse --short HEAD)

# Бэкап перед обновлением — на случай неудачной миграции.
bash "$APP_DIR/infra/scripts/backup.sh"

echo -e "${C}==> Сборка образа api ($after)${N}"
sed -i "s/^NODESERVICE_VERSION=.*/NODESERVICE_VERSION=$after/" "$ENV_FILE"
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
docker image prune -f >/dev/null 2>&1 || true
echo -e "${G}Обновлено: $before → $after.${N} Откат при необходимости: nodeservice rollback"
