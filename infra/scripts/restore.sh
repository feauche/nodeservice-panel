#!/usr/bin/env bash
# Восстановление панели из бэкапа backup.sh (nodeservice-backup-*.tar.gz; старый формат
# nodeservice-*.dump тоже принимается). Что делает:
#   1. Секреты из бэкапа (ENCRYPTION_KEY, APP_SECRET, PASSWORD_PEPPER) переносятся в infra/.env —
#      без них TOTP, доступы к серверам и ключ панели не расшифровать. Домен и пароль БД
#      остаются текущими: домен — этого сервера, пароль — того Postgres, что уже запущен.
#   2. Текущая БД не удаляется, а переименовывается в nodeservice_pre_restore_<время>:
#      если восстановление сорвётся, она возвращается на место автоматически.
#   3. api перезапускается с новым .env, миграции применяет сам при старте; сессии сбрасываются.
#
#   nodeservice restore <файл> [--yes]      --yes — без вопросов (для install.sh --restore)
set -euo pipefail
APP_DIR="${NODESERVICE_DIR:-/opt/nodeservice}"
ENV_FILE="$APP_DIR/infra/.env"
COMPOSE=(docker compose -f "$APP_DIR/infra/compose.yaml" --env-file "$ENV_FILE")
R='\033[1;31m'; G='\033[0;32m'; Y='\033[1;33m'; C='\033[0;36m'; N='\033[0m'
die() { echo -e "${R}[-] $1${N}" >&2; exit 1; }
step() { echo -e "${C}==> $1${N}"; }

f=""; YES=0
while [[ $# -gt 0 ]]; do
    case "$1" in
        --yes|-y) YES=1; shift ;;
        -h|--help) sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *) f="$1"; shift ;;
    esac
done
[[ -n "$f" && -f "$f" ]] || die "Укажи файл бэкапа: nodeservice restore $APP_DIR/backups/nodeservice-backup-<время>.tar.gz"
f=$(readlink -f "$f")
[[ -f "$ENV_FILE" ]] || die "Панель не установлена в $APP_DIR — на чистом сервере: install.sh --restore $f"

work=$(mktemp -d "${TMPDIR:-/tmp}/nodeservice-restore.XXXXXX"); chmod 700 "$work"
trap 'rm -rf "$work"' EXIT

# --- распаковка: архив нового формата или голый дамп (+ env-<время> рядом, если есть) ---------
[[ -s "$f" ]] || die "Файл пустой: $f"
if [[ "$(head -c 5 "$f")" == "PGDMP" ]]; then
    # Старый формат: голый pg_dump -Fc, .env лежал рядом как env-<время>.
    cp "$f" "$work/db.dump"
    old_env="$(dirname "$f")/env-$(basename "$f" | sed -E 's/^nodeservice-(.*)\.dump$/\1/')"
    [[ -f "$old_env" ]] && cp "$old_env" "$work/env"
elif tar -tzf "$f" >/dev/null 2>&1; then
    tar -C "$work" -xzf "$f" || die "Архив не распаковался: $f"
    [[ -f "$work/db.dump" ]] || die "В архиве нет db.dump — это не бэкап панели."
    [[ -f "$work/meta" ]] && { echo "Бэкап:"; sed 's/^/  /' "$work/meta"; }
else
    die "Не похоже на бэкап панели (ожидается nodeservice-backup-*.tar.gz или дамп pg_dump -Fc): $f"
fi
"${COMPOSE[@]}" exec -T postgres pg_restore --list < "$work/db.dump" >/dev/null 2>&1 || die "Файл не читается как дамп pg_dump -Fc: $f"

# --- секреты: сравниваем .env бэкапа с текущим ----------------------------------------------
envval() { grep -E "^$2=" "$1" 2>/dev/null | head -1 | cut -d= -f2- || true; }
NEW_ENV=""
if [[ -f "$work/env" ]]; then
    diff_keys=()
    for k in ENCRYPTION_KEY ENCRYPTION_KEY_VERSION APP_SECRET PASSWORD_PEPPER; do
        [[ "$(envval "$work/env" $k)" != "$(envval "$ENV_FILE" $k)" ]] && diff_keys+=("$k")
    done
    if (( ${#diff_keys[@]} > 0 )); then
        echo -e "${Y}Секреты в бэкапе отличаются от текущих (${diff_keys[*]}).${N}"
        echo "Без ключей из бэкапа TOTP администратора, доступы к серверам и SSH-ключ панели не расшифровать,"
        echo "поэтому они будут взяты из бэкапа. Домен ($(envval "$ENV_FILE" PANEL_DOMAIN)) и пароль БД остаются текущими."
        NEW_ENV="$work/env.merged"
        cp "$ENV_FILE" "$NEW_ENV"
        for k in ENCRYPTION_KEY ENCRYPTION_KEY_VERSION APP_SECRET PASSWORD_PEPPER; do
            v=$(envval "$work/env" $k)
            [[ -n "$v" ]] || continue
            # Без sed -i: значение подставляем через временный файл (одинаково на GNU и BSD sed).
            { grep -vE "^$k=" "$NEW_ENV" || true; echo "$k=$v"; } > "$NEW_ENV.tmp" && mv "$NEW_ENV.tmp" "$NEW_ENV"
        done
    fi
else
    echo -e "${Y}В бэкапе нет .env — считаю, что текущий infra/.env содержит те же ключи, что и на момент бэкапа.${N}"
fi

echo -e "${R}Текущая БД будет ЗАМЕНЕНА содержимым $f.${N}"
if (( YES == 0 )); then
    read -rp "Введи 'yes' для подтверждения: " a </dev/tty
    [[ "$a" == "yes" ]] || { echo "Отменено."; exit 0; }
fi

psql() { "${COMPOSE[@]}" exec -T postgres psql -U nodeservice -d postgres -v ON_ERROR_STOP=1 "$@"; }
ts=$(date -u +%Y%m%d_%H%M%S)
keep="nodeservice_pre_restore_$ts"

step "Останавливаю api"
"${COMPOSE[@]}" stop api >/dev/null
# Что бы дальше ни случилось, api поднимаем обратно.
trap 'rm -rf "$work"; "${COMPOSE[@]}" up -d api >/dev/null 2>&1 || true' EXIT

step "Восстанавливаю БД"
psql -c "ALTER DATABASE nodeservice RENAME TO $keep;"
if ! psql -c "CREATE DATABASE nodeservice OWNER nodeservice;"; then
    psql -c "ALTER DATABASE $keep RENAME TO nodeservice;" || true
    die "Не удалось создать пустую БД — прежняя возвращена на место, api запускается."
fi
if ! "${COMPOSE[@]}" exec -T postgres pg_restore -U nodeservice -d nodeservice --no-owner --no-privileges < "$work/db.dump"; then
    echo -e "${R}pg_restore завершился с ошибкой — возвращаю прежнюю БД.${N}" >&2
    psql -c "DROP DATABASE nodeservice WITH (FORCE);" -c "ALTER DATABASE $keep RENAME TO nodeservice;"
    die "Прежняя БД на месте, api запускается. Бэкап $f повреждён или несовместим."
fi

if [[ -n "$NEW_ENV" ]]; then
    step "Обновляю infra/.env (секреты из бэкапа)"
    cp "$ENV_FILE" "$ENV_FILE.pre_restore_$ts"; chmod 600 "$ENV_FILE.pre_restore_$ts"
    install -m 600 "$NEW_ENV" "$ENV_FILE"
    echo "Прежний .env сохранён: $ENV_FILE.pre_restore_$ts"
fi
# Сессии и rate-limit относятся к прежнему состоянию — сбрасываем.
"${COMPOSE[@]}" exec -T valkey valkey-cli FLUSHALL >/dev/null 2>&1 || true

step "Запускаю api"
trap 'rm -rf "$work"' EXIT
"${COMPOSE[@]}" up -d --force-recreate api >/dev/null 2>&1 || true
st=starting
for _ in $(seq 1 60); do
    st=$(docker inspect -f '{{.State.Health.Status}}' nodeservice-api-1 2>/dev/null || echo starting)
    [[ "$st" == "healthy" ]] && break
    sleep 3
done
if [[ "$st" != "healthy" ]]; then
    "${COMPOSE[@]}" logs --tail=80 api || true
    die "api не поднялся после восстановления (статус: $st). БД до восстановления сохранена как $keep."
fi
echo -e "${G}Восстановлено из $f.${N}"
echo "Старая БД сохранена как $keep — удали, когда убедишься, что всё в порядке:"
echo "  docker compose -f $APP_DIR/infra/compose.yaml --env-file $ENV_FILE exec postgres psql -U nodeservice -d postgres -c 'DROP DATABASE $keep'"
echo "Проверка: войди в панель — пароль и код из приложения те же, что были на момент бэкапа."
