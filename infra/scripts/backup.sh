#!/usr/bin/env bash
# Бэкап БД (pg_dump, custom-формат, сжатый) + копия infra/.env. Хранится 14 дней.
set -euo pipefail
APP_DIR="${NODESERVICE_DIR:-/opt/nodeservice}"
COMPOSE=(docker compose -f "$APP_DIR/infra/compose.yaml" --env-file "$APP_DIR/infra/.env")
OUT="$APP_DIR/backups"; mkdir -p -m 700 "$OUT"
ts=$(date -u +%Y%m%d-%H%M%S)
f="$OUT/nodeservice-$ts.dump"
# Пишем во временный файл: битый/пустой дамп при сбое pg_dump не должен остаться под именем бэкапа.
trap 'rm -f "$f.tmp"' EXIT
"${COMPOSE[@]}" exec -T postgres pg_dump -U nodeservice -d nodeservice -Fc > "$f.tmp"
[[ -s "$f.tmp" ]] || { echo "pg_dump вернул пустой файл" >&2; exit 1; }
mv "$f.tmp" "$f"
cp "$APP_DIR/infra/.env" "$OUT/env-$ts"
chmod 600 "$f" "$OUT/env-$ts"
find "$OUT" -type f -mtime +14 -delete
echo "бэкап: $f ($(du -h "$f" | cut -f1)), .env → $OUT/env-$ts"
