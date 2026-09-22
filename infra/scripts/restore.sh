#!/usr/bin/env bash
# Восстановление БД из бэкапа backup.sh. Текущая БД не удаляется, а переименовывается
# в nodeservice_pre_restore_<время>: если восстановление сорвётся, её можно вернуть.
set -euo pipefail
APP_DIR="${NODESERVICE_DIR:-/opt/nodeservice}"
COMPOSE=(docker compose -f "$APP_DIR/infra/compose.yaml" --env-file "$APP_DIR/infra/.env")
R='\033[1;31m'; G='\033[0;32m'; Y='\033[1;33m'; N='\033[0m'
f="${1:-}"
[[ -f "$f" ]] || { echo -e "${R}Укажи файл бэкапа: nodeservice restore $APP_DIR/backups/nodeservice-....dump${N}" >&2; exit 1; }
"${COMPOSE[@]}" exec -T postgres pg_restore --list < "$f" >/dev/null 2>&1 || { echo -e "${R}Файл не читается как дамп pg_dump -Fc: $f${N}" >&2; exit 1; }
echo -e "${R}Текущая БД будет ЗАМЕНЕНА содержимым $f.${N}"
read -rp "Введи 'yes' для подтверждения: " a </dev/tty
[[ "$a" == "yes" ]] || { echo "Отменено."; exit 0; }

psql() { "${COMPOSE[@]}" exec -T postgres psql -U nodeservice -d postgres -v ON_ERROR_STOP=1 "$@"; }
keep="nodeservice_pre_restore_$(date -u +%Y%m%d_%H%M%S)"

"${COMPOSE[@]}" stop api
# Что бы дальше ни случилось, api поднимаем обратно.
trap '"${COMPOSE[@]}" up -d api >/dev/null 2>&1 || true' EXIT
psql -c "ALTER DATABASE nodeservice RENAME TO $keep;"
if ! psql -c "CREATE DATABASE nodeservice OWNER nodeservice;"; then
    psql -c "ALTER DATABASE $keep RENAME TO nodeservice;" || true
    echo -e "${R}Не удалось создать пустую БД — прежняя возвращена на место, api запускается.${N}" >&2
    exit 1
fi
if "${COMPOSE[@]}" exec -T postgres pg_restore -U nodeservice -d nodeservice --no-owner --no-privileges < "$f"; then
    echo -e "${G}Восстановлено из $f.${N} Старая БД сохранена как $keep — удали, когда убедишься, что всё в порядке:"
    echo "  nodeservice cli --help  # проверить вход;  затем: docker compose ... exec postgres psql -U nodeservice -d postgres -c 'DROP DATABASE $keep'"
    echo -e "${Y}Проверь, что infra/.env содержит тот же ENCRYPTION_KEY, что и на момент бэкапа.${N}"
else
    echo -e "${R}pg_restore завершился с ошибкой — возвращаю прежнюю БД.${N}" >&2
    psql -c "DROP DATABASE nodeservice WITH (FORCE);" -c "ALTER DATABASE $keep RENAME TO nodeservice;"
    echo -e "${Y}Прежняя БД на месте, api запускается. Бэкап $f повреждён или несовместим.${N}"
    exit 1
fi
