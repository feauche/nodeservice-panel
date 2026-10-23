# shellcheck shell=bash
# Набор файлов compose установленной панели. Основной compose.yaml — всегда; если панель открыта через ваш
# nginx или Caddy, установщик записал в infra/.env, как именно, и сюда добавляется оверлей:
#   PANEL_PROXY=internal — только внутренняя сеть: api на внутреннем адресе, http (compose.internal.yaml);
#   PANEL_PROXY_NETWORK — Caddy в другом контейнере: api в его сети (compose.docker-proxy.yaml);
#   PANEL_LOCAL_PORT    — nginx или Caddy на сервере: api на 127.0.0.1:порт (compose.host-proxy.yaml).
# Использование: . compose-args.sh; nodeservice_compose "$APP_DIR" "$ENV_FILE" — задаёт массив COMPOSE.
nodeservice_compose() {
    local dir=$1 env=$2
    COMPOSE=(docker compose -f "$dir/infra/compose.yaml")
    if grep -qxE 'PANEL_PROXY=internal' "$env" 2>/dev/null; then
        COMPOSE+=(-f "$dir/infra/compose.internal.yaml")
    elif grep -qE '^PANEL_PROXY_NETWORK=.+' "$env" 2>/dev/null; then
        COMPOSE+=(-f "$dir/infra/compose.docker-proxy.yaml")
    elif grep -qE '^PANEL_LOCAL_PORT=[0-9]+' "$env" 2>/dev/null; then
        COMPOSE+=(-f "$dir/infra/compose.host-proxy.yaml")
    fi
    COMPOSE+=(--env-file "$env")
}
