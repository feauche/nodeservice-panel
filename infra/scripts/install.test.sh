#!/usr/bin/env bash
# Функции установщика без установки: кто держит порты, разбор nginx и Caddy, блоки настроек, сертификаты,
# перенос текста, выбор файлов compose, удаление сайта панели. Вместо ss, docker, nginx, caddy, curl, systemctl —
# заглушки в PATH, вместо /proc — папка с cgroup. Нужны GNU-утилиты и openssl (Ubuntu/Debian, CI).
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
work=$(mktemp -d "${TMPDIR:-/tmp}/nodeservice-install-test.XXXXXX")
trap 'rm -rf "$work"' EXIT
mkdir -p "$work/bin" "$work/proc" "$work/ss" "$work/docker"
# Как в установщике: длина строки — в знаках, а не в байтах.
export LC_ALL=C.UTF-8
export PATH="$work/bin:$PATH" NS_PROC="$work/proc" NODESERVICE_INSTALL_LOG="$work/install.log" COLUMNS=80
export SS_DIR="$work/ss" DOCKER_DIR="$work/docker" NODESERVICE_VERIFY_PAUSE=0

cat >"$work/bin/ss" <<'SH'
#!/usr/bin/env bash
proto=tcp
[[ "$*" == *-lu* ]] && proto=udp
port=$(sed -n 's/.*sport = :\([0-9]*\).*/\1/p' <<<"$*")
[[ -f "$SS_DIR/$proto-$port" ]] && cat "$SS_DIR/$proto-$port"
exit 0
SH
cat >"$work/bin/docker" <<'SH'
#!/usr/bin/env bash
case "$1" in
  ps) f=$(sed -n 's/.*publish=\([0-9]*\)\/\([a-z]*\).*/publish-\1-\2/p' <<<"$*"); [[ -f "$DOCKER_DIR/$f" ]] && cat "$DOCKER_DIR/$f" ;;
  inspect)
    target=${!#}
    case "$*" in
      *Mounts*) cat "$DOCKER_DIR/mounts-$target" 2>/dev/null ;;
      *NetworkMode*) cat "$DOCKER_DIR/netmode-$target" 2>/dev/null ;;
      *Networks*) cat "$DOCKER_DIR/networks-$target" 2>/dev/null ;;
      *) cat "$DOCKER_DIR/inspect-$target" 2>/dev/null || exit 1 ;;
    esac ;;
  network) echo 172.17.0.1 ;;
  exec) echo "docker $*" >>"$DOCKER_DIR/exec.log" ;;
esac
exit 0
SH
cat >"$work/bin/nginx" <<'SH'
#!/usr/bin/env bash
case "$1" in
  -T) cat "$NGINX_DUMP_FILE" ;;
  -v) echo "nginx version: nginx/${NGINX_V:-1.24.0}" >&2 ;;
  -t) [[ "${NGINX_T_RC:-0}" == 0 ]] && echo "nginx: configuration file /etc/nginx/nginx.conf test is successful" >&2 ||
        echo 'nginx: [emerg] unknown directive "proxy_pas" in /etc/nginx/sites-enabled/shop.conf:14' >&2
      exit "${NGINX_T_RC:-0}" ;;
  -s) echo "reload" >>"$DOCKER_DIR/nginx.log" ;;
esac
exit 0
SH
cat >"$work/bin/systemctl" <<'SH'
#!/usr/bin/env bash
case "$1" in
  is-active) exit 1 ;;
  show) echo 'ExecStart={ path=/usr/bin/caddy ; argv[]=/usr/bin/caddy run --environ --config /srv/caddy/Caddyfile --adapter caddyfile ; }' ;;
esac
exit 0
SH
cat >"$work/bin/curl" <<'SH'
#!/usr/bin/env bash
out=""
while [[ $# -gt 0 ]]; do [[ "$1" == -o ]] && { out=$2; shift; }; shift; done
case "${CURL_MODE:-ok}" in
  ok) printf '{"status":"ok","uptime":1}' >"$out"; printf '200' ;;
  tls) echo "curl: (60) SSL certificate problem" >&2; exit 60 ;;
  refused) echo "curl: (7) Failed to connect" >&2; exit 7 ;;
  http) printf '<html>502</html>' >"$out"; printf '502' ;;
esac
SH
chmod +x "$work/bin/"*

# shellcheck disable=SC1091
NODESERVICE_INSTALL_LIB=1 source "$ROOT/infra/scripts/install.sh"
# shellcheck disable=SC2034  # цвета и ENV_FILE читают функции установщика
C='' G='' Y='' R='' B='' D='' A='' N=''
# shellcheck disable=SC2034
ENV_FILE="$work/.env"

fails=0
check() {
    local name=$1
    shift
    if "$@"; then printf 'ok   %s\n' "$name"; else printf 'FAIL %s\n' "$name"; fails=$((fails + 1)); fi
}
eq() { [[ "$1" == "$2" ]] || { printf '     ожидалось: %q\n     получено:  %q\n' "$2" "$1"; return 1; }; }
has() { grep -qF -- "$2" <<<"$1" || { printf '     нет строки: %s\n' "$2"; return 1; }; }
hasnt() { if grep -qF -- "$2" <<<"$1"; then printf '     лишняя строка: %s\n' "$2"; return 1; fi; }

listen() { printf 'LISTEN 0 511 %s 0.0.0.0:* users:(("%s",pid=%s,fd=6))\n' "$3" "$4" "$5" >"$SS_DIR/$1-$2"; }
cgroup() { mkdir -p "$NS_PROC/$1"; printf '0::%s\n' "$2" >"$NS_PROC/$1/cgroup"; }
reset_ports() { rm -rf "${SS_DIR:?}"/* "${DOCKER_DIR:?}"/* "${NS_PROC:?}"/*; }
CID=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef

# --- Кто держит порт ---
reset_ports
check "порт свободен" eq "$(port_holder tcp 80)" "free|свободен||"
listen tcp 443 0.0.0.0:443 nginx 812
cgroup 812 /system.slice/nginx.service
check "nginx на 443" eq "$(port_holder tcp 443)" "nginx|nginx||"
listen tcp 80 0.0.0.0:80 caddy 900
cgroup 900 /system.slice/caddy.service
check "Caddy-служба на 80" eq "$(port_holder tcp 80)" "caddy|Caddy||"
listen udp 443 '*:443' hysteria 950
check "Hysteria на UDP 443 — VPN" eq "$(holder_kind "$(port_holder udp 443)")" vpn
listen tcp 8080 0.0.0.0:8080 haproxy 1000
check "чужая программа" eq "$(port_holder tcp 8080)" "other|haproxy||"
reset_ports
listen tcp 443 0.0.0.0:443 docker-proxy 1200
printf 'caddy\tcaddy:2.9\tabc\n' >"$DOCKER_DIR/publish-443-tcp"
check "Caddy в контейнере (docker-proxy)" eq "$(port_holder tcp 443)" "caddy-docker|контейнер caddy (Caddy)|caddy|caddy:2.9"
printf 'nodeservice-caddy-1\tcaddy:2.11-alpine\tdef\n' >"$DOCKER_DIR/publish-443-tcp"
check "свой Caddy панели" eq "$(holder_kind "$(port_holder tcp 443)")" own
reset_ports
printf 'nginx\tnginx:1.27\tghi\n' >"$DOCKER_DIR/publish-80-tcp"
check "проброс без docker-proxy: nginx в контейнере — чужой" eq "$(port_holder tcp 80)" "other|контейнер nginx|nginx|nginx:1.27"
listen tcp 443 0.0.0.0:443 xray 1300
cgroup 1300 "/system.slice/docker-$CID.scope"
printf '/remnanode\tremnawave/node:latest\t%s\n' "$CID" >"$DOCKER_DIR/inspect-$CID"
check "нода Remnawave с сетью хоста — VPN" eq "$(port_holder tcp 443)" "vpn|контейнер remnanode — VPN|remnanode|remnawave/node:latest"
reset_ports
listen tcp 443 0.0.0.0:443 xray 1400
check "Xray без контейнера — VPN" eq "$(port_holder tcp 443)" "vpn|xray — VPN||"

# --- Адрес listen и свободный порт ---
reset_ports
listen tcp 443 0.0.0.0:443 nginx 1
check "nginx на всех адресах" eq "$(listen_address 443)" ""
listen tcp 443 203.0.113.10:443 nginx 1
check "nginx на одном адресе" eq "$(listen_address 443)" "203.0.113.10"
reset_ports
listen tcp 3080 127.0.0.1:3080 node 1
check "свободный внутренний порт" eq "$(free_port 3080 3199)" 3081
listen udp 8443 '*:8443' hysteria 1
check "8443 занят по UDP — берём 8444" eq "$(free_port 8443 8499 udp)" 8444

# --- nginx ---
export NGINX_DUMP_FILE="$work/nginx-T"
cat >"$NGINX_DUMP_FILE" <<'EOF'
nginx: the configuration file /etc/nginx/nginx.conf syntax is ok
# configuration file /etc/nginx/nginx.conf:
http {
    include /etc/nginx/conf.d/*.conf;
    include /etc/nginx/sites-enabled/*;
}
# configuration file /etc/nginx/sites-enabled/shop.conf:
server {
    listen 80;
    listen [::]:80;
    server_name shop.example.com www.shop.example.com;
}
# configuration file /etc/nginx/sites-enabled/one-line.conf:
server { listen 80; server_name blog.example.com; return 200 "blog"; }
# configuration file /etc/nginx/sites-enabled/old-panel:
server {
    server_name panel.example.com;
}
# configuration file /etc/nginx/sites-enabled/nodeservice:
server {
    server_name panel.example.com;
}
EOF
NGINX_DUMP=""
check "сайты nginx, и в одну строку тоже" eq "$(nginx_sites | paste -sd, -)" "blog.example.com,panel.example.com,shop.example.com,www.shop.example.com"
check "конфликт имени — чужой файл" eq "$(nginx_conflict_file panel.example.com /etc/nginx/sites-enabled/nodeservice)" \
    /etc/nginx/sites-enabled/old-panel
check "конфликта нет у другого домена" eq "$(nginx_conflict_file new.example.com)" ""
check "имена одного файла" eq "$(nginx_file_names /etc/nginx/sites-enabled/shop.conf | paste -sd, -)" \
    "shop.example.com,www.shop.example.com"
mkdir -p "$work/nginx/sites-enabled"
sed "s#/etc/nginx#$work/nginx#g" "$NGINX_DUMP_FILE" >"$work/nginx-T2"
NGINX_DUMP_FILE="$work/nginx-T2" NGINX_DUMP=""
check "сайт панели — в sites-available со ссылкой" eq "$(NGINX_DIR="$work/nginx" nginx_site_paths)" \
    "$work/nginx/sites-available/nodeservice"$'\t'"$work/nginx/sites-enabled/nodeservice"
printf 'http {\n    include %s/conf.d/*.conf;\n}\n' "$work/nginx" >"$work/nginx-T3"
NGINX_DUMP_FILE="$work/nginx-T3" NGINX_DUMP=""
check "сайт панели — в conf.d без ссылки" eq "$(NGINX_DIR="$work/nginx" nginx_site_paths)" "$work/nginx/conf.d/nodeservice.conf"$'\t'
printf 'http {\n}\n' >"$work/nginx-T4"
NGINX_DUMP_FILE="$work/nginx-T4" NGINX_DUMP=""
check "nginx без sites-enabled и conf.d — некуда" bash -c '! (NODESERVICE_INSTALL_LIB=1 . "$1"; NGINX_DIR="$2" nginx_site_paths >/dev/null)' _ \
    "$ROOT/infra/scripts/install.sh" "$work/nginx"
check "http2: nginx 1.24 — в listen" eq "$(nginx_http2_style 1.24.0)" old
check "http2: nginx 1.25.1 — строкой" eq "$(nginx_http2_style 1.25.1)" new
check "http2: nginx 1.27.3 — строкой" eq "$(nginx_http2_style 1.27.3)" new
conf=$(nginx_conf panel.example.com 127.0.0.1:3080 http 0 old)
check "этап http: проверка Let’s Encrypt" has "$conf" "location /.well-known/acme-challenge/ { root /var/www/nodeservice-acme; }"
check "этап http: без https" hasnt "$conf" "listen 443"
conf=$(nginx_conf panel.example.com 127.0.0.1:3080 https 1 old /c/full.pem /c/key.pem)
check "https для nginx 1.24: http2 в listen" has "$conf" "listen 443 ssl http2;"
check "https: IPv6" has "$conf" "listen [::]:443 ssl http2;"
check "https: панель" has "$conf" "proxy_pass http://127.0.0.1:3080;"
check "https: живой журнал без буфера" has "$conf" "proxy_buffering off;"
check "https: копия до 2 ГБ" has "$conf" "client_max_body_size 2g;"
check "https: сертификат" has "$conf" "ssl_certificate /c/full.pem;"
conf=$(nginx_conf panel.example.com 127.0.0.1:3080 https 0 new /c/full.pem /c/key.pem 203.0.113.10)
check "https для новых nginx: http2 on" has "$conf" "http2 on;"
check "https без IPv6" hasnt "$conf" "[::]"
check "https на адресе nginx" has "$conf" "listen 203.0.113.10:443 ssl;"
t=$'nginx: [emerg] unknown directive "proxy_pas" in /etc/nginx/sites-enabled/shop.conf:14\nnginx: configuration file /etc/nginx/nginx.conf test failed'
check "ошибка nginx: файл и строка" eq "$(nginx_error_where "$t")" "/etc/nginx/sites-enabled/shop.conf 14"
check "ошибка nginx: строка для поддержки" eq "$(nginx_error_line "$t")" \
    '[emerg] unknown directive "proxy_pas" in /etc/nginx/sites-enabled/shop.conf:14'
t2=$'2026/10/13 23:59:37 [emerg] 41231#41231: unknown directive "proxy_pas" in /etc/nginx/sites-enabled/shop.conf:1'
check "ошибка nginx: без даты и номера процесса" eq "$(nginx_error_line "$t2")" \
    '[emerg] unknown directive "proxy_pas" in /etc/nginx/sites-enabled/shop.conf:1'

# --- Caddy ---
cf="$work/Caddyfile"
printf '{\n\temail a@example.com\n}\n\nremna.example.com {\n\treverse_proxy remnawave:3000\n}\n' >"$cf"
check "Caddyfile службы — из ExecStart" eq "$(caddy_unit_config)" /srv/caddy/Caddyfile
check "своего сайта в Caddy нет" bash -c '! (NODESERVICE_INSTALL_LIB=1 . "$1"; caddyfile_has_site "$2" panel.example.com)' _ "$ROOT/infra/scripts/install.sh" "$cf"
printf 'a.example.com, https://panel.example.com:443 {\n\trespond ok\n}\n' >"$work/Caddyfile2"
check "сайт в списке адресов" caddyfile_has_site "$work/Caddyfile2" panel.example.com
printf '# panel.example.com {\nxpanel.example.com {\n}\n' >"$work/Caddyfile3"
check "комментарий и похожее имя — не сайт" bash -c '! (NODESERVICE_INSTALL_LIB=1 . "$1"; caddyfile_has_site "$2" panel.example.com)' _ "$ROOT/infra/scripts/install.sh" "$work/Caddyfile3"
inode=$(stat -c %i "$cf")
marker_block_set "$cf" "$(caddy_site_block panel.example.com nodeservice-api:3000)"
marker_block_set "$cf" "$(caddy_site_block panel.example.com nodeservice-api:3000)"
check "блок панели один, даже после повтора" eq "$(grep -c '^panel.example.com {' "$cf")" 1
check "блок панели — между метками" has "$(cat "$cf")" "$MARK_END"
check "свой блок не считается чужим сайтом" bash -c '! (NODESERVICE_INSTALL_LIB=1 . "$1"; caddyfile_has_site "$2" panel.example.com)' _ "$ROOT/infra/scripts/install.sh" "$cf"
check "чужой сайт на месте" has "$(cat "$cf")" "remna.example.com {"
check "Caddyfile переписан на месте (контейнер видит тот же файл)" eq "$(stat -c %i "$cf")" "$inode"
marker_block_set "$cf" ""
check "блок панели убран" hasnt "$(cat "$cf")" "panel.example.com"
check "после удаления блока чужой сайт на месте" has "$(cat "$cf")" "reverse_proxy remnawave:3000"
block=$(caddy_site_block panel.example.com 127.0.0.1:3080)
check "блок Caddy: панель" has "$block" "reverse_proxy 127.0.0.1:3080 {"
check "блок Caddy: поток без буфера" has "$block" "flush_interval -1"
caddy_import_set "$cf" /etc/caddy/nodeservice.caddy
caddy_import_set "$cf" /etc/caddy/nodeservice.caddy
check "import один, даже после повтора" eq "$(grep -c '^import /etc/caddy/nodeservice.caddy$' "$cf")" 1
caddy_import_unset "$cf" /etc/caddy/nodeservice.caddy
check "import убран" hasnt "$(cat "$cf")" "nodeservice.caddy"
check "import убран вместе с пометкой" hasnt "$(cat "$cf")" "$CADDY_IMPORT_NOTE"
check "import убран на месте" eq "$(stat -c %i "$cf")" "$inode"
printf '/opt/remnawave/caddy\t/etc/caddy\n/var/lib/docker/volumes/x\t/data\n' >"$DOCKER_DIR/mounts-caddy"
check "Caddyfile контейнера — папка /etc/caddy" eq "$(docker_caddyfile caddy)" "/opt/remnawave/caddy/Caddyfile"$'\t'"/etc/caddy/Caddyfile"
printf '/root/Caddyfile\t/etc/caddy/Caddyfile\n' >"$DOCKER_DIR/mounts-caddy"
check "Caddyfile контейнера — файлом" eq "$(docker_caddyfile caddy)" "/root/Caddyfile"$'\t'"/etc/caddy/Caddyfile"
printf 'bridge\nremnawave-network\n' >"$DOCKER_DIR/networks-caddy"
check "сеть контейнера — не bridge" eq "$(docker_networks caddy)" remnawave-network

# --- Сертификаты ---
live="$work/live"
mkcert() {
    mkdir -p "$live/$1"
    openssl req -x509 -newkey rsa:2048 -nodes -days "$3" -subj "/CN=$1" -addext "subjectAltName=$2" \
        -keyout "$live/$1/privkey.pem" -out "$live/$1/fullchain.pem" >/dev/null 2>&1
}
mkcert shop.example.com DNS:shop.example.com 90
mkcert soon.example.com DNS:panel.example.com 3
check "нет сертификата для домена (и истекающий не берём)" bash -c '! (NODESERVICE_INSTALL_LIB=1 . "$1"; LE_LIVE_DIR="$2" le_cert_for panel.example.com >/dev/null)' _ \
    "$ROOT/infra/scripts/install.sh" "$live"
mkcert example.com 'DNS:example.com,DNS:*.example.com' 90
check "подходит сертификат *.example.com" eq "$(LE_LIVE_DIR="$live" le_cert_for panel.example.com | cut -f1)" "$live/example.com/fullchain.pem"
check "причина certbot: DNS" has "$(certbot_reason 'DNS problem: NXDOMAIN looking up A for panel.example.com')" "DNS"
check "причина certbot: лимит" has "$(certbot_reason 'Error: too many certificates already issued')" "через час"
check "причина certbot: порт 80" has "$(certbot_reason 'Timeout during connect (likely firewall problem)')" "порту 80"
check "дата по-русски" eq "$(ru_date 'Jan 11 12:00:00 2027 GMT')" "11 января 2027"
check "дата коротко" eq "$(ru_date 'Jan 11 12:00:00 2027 GMT' short)" "11.01.2027"

# --- Проверка https ---
check "панель открывается" bash -c 'NODESERVICE_INSTALL_LIB=1 . "$1"; CURL_MODE=ok verify_panel panel.example.com 443 2 && [[ $VERIFY_STATE == ok ]]' _ "$ROOT/infra/scripts/install.sh"
check "сертификата нет — tls" bash -c 'NODESERVICE_INSTALL_LIB=1 . "$1"; ! CURL_MODE=tls verify_panel panel.example.com 443 2 && [[ $VERIFY_STATE == tls ]]' _ "$ROOT/infra/scripts/install.sh"
check "никто не слушает — refused" bash -c 'NODESERVICE_INSTALL_LIB=1 . "$1"; ! CURL_MODE=refused verify_panel panel.example.com 443 2 && [[ $VERIFY_STATE == refused ]]' _ "$ROOT/infra/scripts/install.sh"
check "отвечает не панель — http" bash -c 'NODESERVICE_INSTALL_LIB=1 . "$1"; ! CURL_MODE=http verify_panel panel.example.com 443 2 && [[ $VERIFY_STATE == http && $VERIFY_DETAIL == *502* ]]' _ "$ROOT/infra/scripts/install.sh"

# --- Вывод ---
check "русское число" eq "$(plural 2 ядро ядра ядер), $(plural 5 ядро ядра ядер), $(plural 21 ядро ядра ядер), $(plural 12 ядро ядра ядер)" \
    "2 ядра, 5 ядер, 21 ядро, 12 ядер"
check "гигабайты" eq "$(gb 3936) $(gb 4096) $(gb 1024)" "3,8 4 1"
check "длительность" eq "$(dur 252) $(dur 40)" "4 мин 12 с 40 с"
check "видимая длина без цветов" eq "$(vis_len $'\033[0;32m✓\033[0m Готово')" 8
out=$(COLUMNS=40 say "Порты 80 и 443 занимает ваш nginx. Панель встанет рядом: добавлю в nginx отдельный сайт.")
longest() { local l m=0; while IFS= read -r l; do (( ${#l} > m )) && m=${#l}; done <<<"$1"; printf '%s\n' "$m"; }
check "перенос по ширине окна" eq "$(( $(longest "$out") <= 40 ))" 1
out=$(COLUMNS=40 wrap_words "1. Сохраню копию настроек nginx и добавлю сайт панели в nginx" 2 "" 5)
check "пункт плана: текст под текстом" eq "$(sed -n 2p <<<"$out" | cut -c1-5)" "     "
out=$(row ok "Домен" "panel.example.com → 203.0.113.10, это этот сервер")
check "строка сводки: значение с 16-го знака" eq "${out:15:17}" "panel.example.com"
out=$(COLUMNS=50 row info "nginx" "1.24 · работает · сайтов 3: example.com, shop.example.com, ещё 1")
check "строка сводки: перенос под значением" eq "$(sed -n 2p <<<"$out" | cut -c1-15)" "               "
printf 'н\n' >"$work/answer"
check "вопрос: «н» — нет" bash -c 'NODESERVICE_INSTALL_LIB=1 . "$1"; ! NS_TTY="$2" yesno "Начать?" y >/dev/null' _ "$ROOT/infra/scripts/install.sh" "$work/answer"
printf '\n' >"$work/answer"
check "вопрос: Enter — ответ по умолчанию" bash -c 'NODESERVICE_INSTALL_LIB=1 . "$1"; ! NS_TTY="$2" yesno "Поставить на 8443?" n >/dev/null' _ "$ROOT/infra/scripts/install.sh" "$work/answer"
check "без вопросов — ответ по умолчанию" bash -c 'NODESERVICE_INSTALL_LIB=1 . "$1"; NODESERVICE_YES=1 yesno "Начать?" y >/dev/null' _ "$ROOT/infra/scripts/install.sh"

# --- Файлы compose по способу открытия ---
# shellcheck disable=SC1091
. "$ROOT/infra/scripts/compose-args.sh"
printf 'PANEL_DOMAIN=panel.example.com\n' >"$work/.env"
nodeservice_compose /opt/nodeservice "$work/.env"
check "свой Caddy — только compose.yaml" eq "${COMPOSE[*]}" "docker compose -f /opt/nodeservice/infra/compose.yaml --env-file $work/.env"
printf 'PANEL_LOCAL_PORT=3080\n' >>"$work/.env"
nodeservice_compose /opt/nodeservice "$work/.env"
check "ваш nginx или Caddy — оверлей с портом" has "${COMPOSE[*]}" "-f /opt/nodeservice/infra/compose.host-proxy.yaml"
printf 'PANEL_DOMAIN=panel.example.com\nPANEL_PROXY_NETWORK=remnawave-network\n' >"$work/.env"
nodeservice_compose /opt/nodeservice "$work/.env"
check "Caddy в контейнере — оверлей с сетью" has "${COMPOSE[*]}" "-f /opt/nodeservice/infra/compose.docker-proxy.yaml"

# --- Удаление сайта панели из nginx ---
site="$work/nginx/sites-available/nodeservice"
mkdir -p "$(dirname "$site")"
echo "server {}" >"$site"
ln -sfn "$site" "$work/nginx/sites-enabled/nodeservice"
printf 'PANEL_PROXY=nginx\nPANEL_PROXY_FILE=%s\nPANEL_PROXY_LINK=%s\n' "$site" "$work/nginx/sites-enabled/nodeservice" >"$work/.env"
ENV_FILE="$work/.env"
proxy_remove
check "сайт панели убран из nginx" bash -c '[[ ! -e $1 && ! -L $2 ]]' _ "$site" "$work/nginx/sites-enabled/nodeservice"
printf 'PANEL_PROXY=caddy-docker\nPANEL_PROXY_CADDYFILE=%s\nPANEL_PROXY_CONTAINER=caddy\n' "$cf" >"$work/.env"
marker_block_set "$cf" "$(caddy_site_block panel.example.com nodeservice-api:3000)"
proxy_remove
check "блок панели убран из Caddy контейнера" hasnt "$(cat "$cf")" "panel.example.com"
check "Caddy контейнера перезагружен" has "$(cat "$DOCKER_DIR/exec.log")" "exec caddy caddy reload"

if (( fails > 0 )); then
    printf '\nНе прошло проверок: %s\n' "$fails" >&2
    exit 1
fi
printf '\nPASS: все проверки установщика прошли.\n'
