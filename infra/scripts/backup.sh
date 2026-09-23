#!/usr/bin/env bash
# Полный бэкап панели одним файлом: nodeservice-backup-<время>.tar.gz = дамп БД (pg_dump -Fc)
# + infra/.env (без него зашифрованные секреты не восстановить) + meta (версия, домен, дата).
# Хранится 14 дней в $APP_DIR/backups. Метрики (VictoriaMetrics) не входят: графики заполнятся
# заново, а том может весить сотни мегабайт.
#
#   nodeservice backup                      → файл в $APP_DIR/backups
#   nodeservice backup --to user@host:/dir  → плюс копия по scp (или в локальную папку)
#
# Восстановить: nodeservice restore <файл>  |  на чистом сервере: install.sh --restore <файл>
set -euo pipefail
APP_DIR="${NODESERVICE_DIR:-/opt/nodeservice}"
COMPOSE=(docker compose -f "$APP_DIR/infra/compose.yaml" --env-file "$APP_DIR/infra/.env")
OUT="$APP_DIR/backups"; mkdir -p -m 700 "$OUT"
KEEP_DAYS=14
R='\033[1;31m'; G='\033[0;32m'; N='\033[0m'
die() { echo -e "${R}[-] $1${N}" >&2; exit 1; }

TO=""
while [[ $# -gt 0 ]]; do
    case "$1" in
        --to) TO="${2:-}"; [[ -n "$TO" ]] || die "--to: укажи user@host:/папка или локальную папку"; shift 2 ;;
        -h|--help) sed -n '2,11p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *) die "Неизвестный параметр: $1 (nodeservice backup [--to назначение])" ;;
    esac
done

ts=$(date -u +%Y%m%d-%H%M%S)
archive="$OUT/nodeservice-backup-$ts.tar.gz"
work=$(mktemp -d "${TMPDIR:-/tmp}/nodeservice-backup.XXXXXX")
# Битый/пустой дамп при сбое pg_dump не должен остаться под именем бэкапа.
trap 'rm -rf "$work" "$archive.tmp"' EXIT
chmod 700 "$work"

"${COMPOSE[@]}" exec -T postgres pg_dump -U nodeservice -d nodeservice -Fc > "$work/db.dump"
[[ -s "$work/db.dump" ]] || die "pg_dump вернул пустой файл — панель запущена? (nodeservice status)"
"${COMPOSE[@]}" exec -T postgres pg_restore --list "$work/db.dump" >/dev/null 2>&1 \
    || "${COMPOSE[@]}" exec -T postgres pg_restore --list < "$work/db.dump" >/dev/null 2>&1 \
    || die "Дамп не читается pg_restore — бэкап не сохранён."
cp "$APP_DIR/infra/.env" "$work/env"
# shellcheck disable=SC1091
domain=$(grep -E '^PANEL_DOMAIN=' "$work/env" | head -1 | cut -d= -f2- || true)
cat > "$work/meta" <<META
format=1
created=$(date -u +%Y-%m-%dT%H:%M:%SZ)
domain=${domain:-?}
code=$(git -C "$APP_DIR" rev-parse --short HEAD 2>/dev/null || echo unknown)
postgres=$("${COMPOSE[@]}" exec -T postgres postgres --version 2>/dev/null | awk '{print $3}' || echo unknown)
host=$(hostname)
META
tar -C "$work" -czf "$archive.tmp" meta env db.dump
mv "$archive.tmp" "$archive"
chmod 600 "$archive"

# Старые бэкапы (и файлы прежнего формата .dump / env-*) — старше KEEP_DAYS дней.
find "$OUT" -maxdepth 1 -type f \( -name 'nodeservice-backup-*.tar.gz' -o -name 'nodeservice-*.dump' -o -name 'env-*' \) -mtime +$KEEP_DAYS -delete
echo -e "${G}Бэкап: $archive ($(du -h "$archive" | cut -f1))${N} — БД + .env, домен ${domain:-?}"

if [[ -n "$TO" ]]; then
    if [[ "$TO" == *:* ]]; then
        scp -q "$archive" "$TO" || die "scp в $TO не удался — бэкап остался только локально."
        echo -e "${G}Копия отправлена: $TO${N}"
    else
        mkdir -p "$TO" && cp "$archive" "$TO/" || die "Не удалось скопировать в $TO."
        echo -e "${G}Копия: $TO/$(basename "$archive")${N}"
    fi
else
    echo "Скачать на свой компьютер: scp root@$(hostname -f 2>/dev/null || hostname):$archive ."
fi
