#!/usr/bin/env bash
# Проверка перед обновлением: только чтение, без миграций, перезапуска и SSH.
set -euo pipefail
APP_DIR="${NODESERVICE_DIR:-/opt/nodeservice}"
ENV_FILE="$APP_DIR/infra/.env"
[[ -f "$ENV_FILE" ]] || { echo 'Не найден infra/.env установленной панели.' >&2; exit 1; }
command -v docker >/dev/null || { echo 'Docker не найден.' >&2; exit 1; }
COMPOSE=(docker compose -f "$APP_DIR/infra/compose.yaml" --env-file "$ENV_FILE")
psql_read() { "${COMPOSE[@]}" exec -T postgres psql -U nodeservice -d nodeservice -X -qAt -v ON_ERROR_STOP=1 -c "BEGIN READ ONLY; $1 COMMIT;"; }
printf 'Код установленной панели: '
git -C "$APP_DIR" describe --tags --always --dirty 2>/dev/null || printf 'не определён\n'
printf 'Контейнеры:\n'
"${COMPOSE[@]}" ps --status running
printf '\nСохранённые данные (количество записей, без содержимого):\n'
psql_read "SELECT json_build_object('providers',(SELECT count(*) FROM providers),'servers',(SELECT count(*) FROM servers),'billing_items',(SELECT count(*) FROM billing_items),'billing_payments',(SELECT count(*) FROM billing_payments),'incidents',(SELECT count(*) FROM incidents));"
printf '\nНастройки перехода (значения и секреты не выводятся):\n'
psql_read "SELECT json_build_object('legacy_autochecks',EXISTS(SELECT 1 FROM app_meta WHERE key='settings.autochecks'),'new_monitoring',EXISTS(SELECT 1 FROM app_meta WHERE key='settings.monitoring'));"
printf '\nЛокальные устаревшие службы на этом сервере:\n'
if command -v systemctl >/dev/null; then
    systemctl list-unit-files nodeservice-agent.service nodeservice-watchdog.timer --no-pager 2>/dev/null || true
else
    printf 'systemd недоступен; службы на других нодах здесь не проверяются.\n'
fi
printf '\nПроверка завершена без изменений. Перед обновлением создайте nodeservice backup и сохраните архив вне сервера.\n'
printf 'Службы на удалённых нодах, реальные данные после миграции и откат этим отчётом не подтверждаются.\n'
