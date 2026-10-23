#!/usr/bin/env bash
# NodeService — установка панели на Ubuntu/Debian VPS одной командой.
#
#   bash <(curl -fsSL https://raw.githubusercontent.com/feauche/nodeservice-panel/main/infra/scripts/install.sh)
#
# Переезд/восстановление на чистом сервере из бэкапа (nodeservice backup):
#   bash <(curl -fsSL …/install.sh) --restore /root/nodeservice-backup-<время>.tar.gz
# — секреты и данные берутся из бэкапа, домен по умолчанию прежний; потом переключите DNS.
#
# Сначала смотрит, что уже есть на сервере, и показывает сводку: кто держит порты 80 и 443 (nginx, Caddy,
# Caddy в контейнере, VPN), есть ли сертификат, куда указывает домен, хватит ли памяти. Затем сам выбирает
# способ открыть панель: свой Caddy на свободных портах, сайт в вашем nginx (с бесплатным сертификатом) или
# Caddy, порт 8443 на ноде с VPN. Спрашивает только «да/нет» и до ответа «Начать?» ничего не меняет. В конце
# сам открывает https://домен: «Готово» — только если отвечает панель. Журнал: /var/log/nodeservice-install.log.
# Повторный запуск безопасен: .env и данные не трогает, собранный образ той же версии не пересобирает.
#
# Без вопросов (ответы по умолчанию): NODESERVICE_YES=1 NODESERVICE_DOMAIN=домен [NODESERVICE_EMAIL=почта]
#
# Без домена, только во внутренней сети (сервер за NAT, вход через VPN или проброс порта по SSH): первым
# вопросом выберите «только во внутренней сети» — панель встанет на внутренний адрес сервера по http
# (http://10.10.10.104), без сертификата. Без вопросов: NODESERVICE_YES=1 NODESERVICE_ADDRESS=10.10.10.104
# [NODESERVICE_PORT=80].

# ============== Функции. Проверяются без установки: NODESERVICE_INSTALL_LIB=1 source install.sh ==============

shopt -s extglob

if [[ -t 1 ]]; then
    C=$'\033[0;36m' G=$'\033[0;32m' Y=$'\033[1;33m' R=$'\033[1;31m' B=$'\033[1m' D=$'\033[2m' A=$'\033[0;94m'
    N=$'\033[0m'
else
    C='' G='' Y='' R='' B='' D='' A='' N=''
fi

LOG="${NODESERVICE_INSTALL_LOG:-/var/log/nodeservice-install.log}"
# Требования к серверу (infra/README.md, «Требования к серверу»): меньше — предупреждаем в сводке.
MIN_MEM_MB=768 MIN_DISK_GB=10
ACME_ROOT=/var/www/nodeservice-acme
MARK_START='# >>> NodeService — сайт панели (добавлено установщиком; убрать: nodeservice uninstall)'
MARK_END='# <<< NodeService'
CADDY_IMPORT_NOTE='# NodeService — сайт панели (добавлено установщиком; убрать: nodeservice uninstall)'

ok()   { printf '%s\n' "${G}[+] $1${N}"; }
info() { printf '%s\n' "[i] $1"; }
warn() { printf '%s\n' "${Y}[!] $1${N}"; }
die()  { printf '%s\n' "${R}✗ $1${N}" >&2; exit 1; }
log()  { printf '%s %s\n' "$(date -u +%FT%TZ)" "$*" >>"$LOG" 2>/dev/null || true; }

# --- Вывод: абзацы с переносом по ширине окна, строки сводки ровными колонками ---

# Ширина вывода: окно терминала, но не шире 80 знаков — длинные строки читать трудно.
term_width() {
    local w=${COLUMNS:-}
    [[ -z $w && -t 1 ]] && w=$(tput cols 2>/dev/null || true)
    [[ $w =~ ^[0-9]+$ ]] || w=80
    (( w > 80 )) && w=80
    (( w < 40 )) && w=40
    printf '%s\n' "$w"
}

# Видимая длина: без цветовых кодов. Знаки, а не байты, — установщик включает C.UTF-8.
vis_len() {
    local s=${1//$'\033'\[*([0-9;])m/}
    printf '%s\n' "${#s}"
}

# Перенос по словам: печатает строки, последнюю — без перевода строки, если $3=prompt (после неё — ввод).
# $2 — отступ первой строки, $4 — следующих (по умолчанию тот же: у пунктов плана текст под текстом).
wrap_words() {
    local text=$1 indent=${2:-0} mode=${3:-} w pad pad2 line="" word cand
    local -a words
    w=$(term_width)
    printf -v pad '%*s' "$indent" ''
    printf -v pad2 '%*s' "${4:-$indent}" ''
    read -r -a words <<<"$text"
    for word in "${words[@]}"; do
        cand=${line:+$line }$word
        if [[ -n $line ]] && (( $(vis_len "$pad$cand") > w )); then
            printf '%s\n' "$pad$line"
            pad=$pad2
            line=$word
        else
            line=$cand
        fi
    done
    if [[ $mode == prompt ]]; then printf '%s ' "$pad$line"; else printf '%s\n' "$pad$line"; fi
}
say() { wrap_words "$1" "${2:-0}"; }

# Строка сводки: знак, название и значение; длинное значение переносится под значением.
row() {
    local mark key=$2 val=$3 w pad line="" word cand first=1 prefix kpad
    local -a words
    case $1 in
        ok) mark="${G}✓${N}" ;;
        busy) mark="${Y}●${N}" ;;
        no) mark="${R}✗${N}" ;;
        warn) mark="${Y}!${N}" ;;
        *) mark="${D}•${N}" ;;
    esac
    kpad=$(( 13 - ${#key} ))
    (( kpad < 1 )) && kpad=1
    printf -v prefix '%s %s%*s' "$mark" "${D}$key${N}" "$kpad" ''
    printf -v pad '%*s' 15 ''
    w=$(( $(term_width) - 15 ))
    read -r -a words <<<"$val"
    for word in "${words[@]}"; do
        cand=${line:+$line }$word
        if [[ -n $line ]] && (( $(vis_len "$cand") > w )); then
            if (( first )); then printf '%s%s\n' "$prefix" "$line"; first=0; else printf '%s%s\n' "$pad" "$line"; fi
            line=$word
        else
            line=$cand
        fi
    done
    if (( first )); then printf '%s%s\n' "$prefix" "$line"; else printf '%s%s\n' "$pad" "$line"; fi
}

# Вопрос «да/нет». $1 — вопрос, $2 — ответ по умолчанию (y или n), $3 — пояснение под вопросом.
# Код 0 — «да». При NODESERVICE_YES=1 — ответ по умолчанию без ожидания (он всё равно печатается).
yesno() {
    local q=$1 def=${2:-y} hint=${3:-} yn a text indent=0
    [[ $def == y ]] && yn='[Д/н]' || yn='[д/Н]'
    if [[ -n $hint ]]; then
        say "${C}?${N} $q"
        text="${D}$hint${N} $yn"
        indent=2
    else
        text="${C}?${N} $q $yn"
    fi
    while true; do
        wrap_words "$text" "$indent" prompt
        if [[ -n ${NODESERVICE_YES:-} ]]; then
            a=""
            [[ $def == y ]] && printf '%s\n' д || printf '%s\n' н
        else
            read -r a <"${NS_TTY:-/dev/tty}" || a=""
        fi
        case "${a,,}" in
            '') [[ $def == y ]]; return ;;
            д|да|y|yes) return 0 ;;
            н|нет|n|no) return 1 ;;
            *) say "${Y}Ответьте «д» — да или «н» — нет.${N}" ;;
        esac
    done
}

# Вопрос со строкой ответа; $2 — ответ по умолчанию. При NODESERVICE_YES=1 — сразу ответ по умолчанию.
ask() {
    local p=$1 d=${2:-} a
    if [[ -n ${NODESERVICE_YES:-} ]]; then
        printf '%s\n' "$p${d:+ [$d]}: $d" >&2
        printf '%s' "$d"
        return
    fi
    read -rp "$p${d:+ [$d]}: " a <"${NS_TTY:-/dev/tty}"
    printf '%s' "${a:-$d}"
}

# Выбор из пунктов: печатает номер выбранного. $1 — вопрос, $2 — номер по умолчанию, дальше — пункты.
# Вопрос и пункты — в stderr: номер читают через $(…). При NODESERVICE_YES=1 — номер по умолчанию.
choose() {
    local q=$1 def=$2 a i=0 item
    shift 2
    say "${C}?${N} $q" >&2
    for item in "$@"; do
        i=$((i + 1))
        wrap_words "$i — $item" 2 "" 6 >&2
    done
    while true; do
        wrap_words "Номер [$def]:" 2 prompt >&2
        if [[ -n ${NODESERVICE_YES:-} ]]; then
            a=""
            printf '%s\n' "$def" >&2
        else
            read -r a <"${NS_TTY:-/dev/tty}" || a=""
        fi
        a=${a:-$def}
        if [[ $a =~ ^[0-9]+$ ]] && (( a >= 1 && a <= $# )); then
            printf '%s\n' "$a"
            return 0
        fi
        say "${Y}Введите номер от 1 до $#.${N}" 2 >&2
    done
}

# Русское число: 1 ядро, 2 ядра, 5 ядер.
plural() {
    local n=$1 n10=$(( $1 % 10 )) n100=$(( $1 % 100 ))
    if (( n10 == 1 && n100 != 11 )); then printf '%s %s\n' "$n" "$2"
    elif (( n10 >= 2 && n10 <= 4 && (n100 < 12 || n100 > 14) )); then printf '%s %s\n' "$n" "$3"
    else printf '%s %s\n' "$n" "$4"; fi
}

# Гигабайты из мегабайт: 3936 → «3,8», 4096 → «4».
gb() {
    local tenths=$(( ($1 * 10 + 512) / 1024 ))
    if (( tenths % 10 == 0 )); then printf '%s\n' "$(( tenths / 10 ))"; else printf '%s,%s\n' "$(( tenths / 10 ))" "$(( tenths % 10 ))"; fi
}

# Свободно на диске, где Docker хранит образы (обычно корневой раздел), в ГБ.
free_disk_gb() {
    local dir
    dir=$(docker info -f '{{.DockerRootDir}}' 2>/dev/null || true)
    [[ -n $dir && -d $dir ]] || dir=/
    df -BG --output=avail "$dir" 2>/dev/null | tail -n 1 | tr -dc '0-9' || true
}

dur() {
    local s=$1
    if (( s >= 60 )); then printf '%d мин %02d с\n' $(( s / 60 )) $(( s % 60 )); else printf '%d с\n' "$s"; fi
}

# Дата сертификата по-русски: «Jan 11 12:00:00 2027 GMT» → «11 января 2027» (или «11.01.2027» при $2=short).
ru_date() {
    local d m y
    read -r d m y < <(date -d "$1" '+%-d %-m %Y' 2>/dev/null) || return 1
    [[ -n $y ]] || return 1
    if [[ ${2:-} == short ]]; then printf '%02d.%02d.%s\n' "$d" "$m" "$y"; return; fi
    local months=(января февраля марта апреля мая июня июля августа сентября октября ноября декабря)
    printf '%s %s %s\n' "$d" "${months[m - 1]}" "$y"
}

# --- Кто держит порт ---

# «имя<TAB>pid» процесса, который слушает порт (по ss); пусто — порт свободен; «?<TAB>» — занят, имени не видно.
port_listener() {
    local flag=t line
    [[ $1 == udp ]] && flag=u
    line=$(ss -H -l"$flag"np "sport = :$2" 2>/dev/null | head -n 1)
    [[ -n $line ]] || return 0
    if [[ $line =~ users:\(\(\"([^\"]+)\",pid=([0-9]+) ]]; then
        printf '%s\t%s\n' "${BASH_REMATCH[1]}" "${BASH_REMATCH[2]}"
    else
        printf '?\t\n'
    fi
}

# Адрес, на котором слушают порт, если не «все адреса»: nginx, слушающий 203.0.113.10:443, не увидит сайт на 0.0.0.0.
listen_address() {
    local addrs
    addrs=$(ss -H -ltn "sport = :$1" 2>/dev/null | awk '{print $4}')
    grep -qE '^(\*|0\.0\.0\.0):' <<<"$addrs" && return 0
    grep -E '^[0-9.]+:' <<<"$addrs" | head -n 1 | sed 's/:[0-9]*$//'
}

# Контейнер процесса: «имя<TAB>образ<TAB>id» (по cgroup процесса) или пусто.
container_of_pid() {
    local id
    id=$(grep -oE '[0-9a-f]{64}' "${NS_PROC:-/proc}/$1/cgroup" 2>/dev/null | head -n 1)
    [[ -n $id ]] && command -v docker >/dev/null || return 0
    docker inspect -f '{{.Name}}{{"\t"}}{{.Config.Image}}{{"\t"}}{{.Id}}' "$id" 2>/dev/null | sed 's#^/##'
}

# Контейнер, опубликовавший порт: «имя<TAB>образ<TAB>id» или пусто.
container_on_port() {
    command -v docker >/dev/null || return 0
    docker ps --filter "publish=$1/$2" --format '{{.Names}}{{"\t"}}{{.Image}}{{"\t"}}{{.ID}}' 2>/dev/null | head -n 1
}

classify_process() {
    case "${1,,}" in
        nginx) printf 'nginx|nginx||\n' ;;
        caddy) printf 'caddy|Caddy||\n' ;;
        xray|v2ray|sing-box|hysteria|hysteria2|trojan|trojan-go|naive|naiveproxy|ss-server|ssserver|ocserv|mtg|tuic-server|rw-core)
            printf 'vpn|%s — VPN||\n' "$1" ;;
        '?') printf 'other|неизвестная программа||\n' ;;
        *) printf 'other|%s||\n' "$1" ;;
    esac
}

classify_container() {
    local name=$1 image=${2,,}
    if [[ $name == nodeservice-caddy-* || $name == nodeservice_caddy_* || $name == nodeservice-api-* || $name == nodeservice_api_* ]]; then
        printf 'own|панель NodeService|%s|%s\n' "$name" "$2"
        return
    fi
    case "$image" in
        caddy|caddy:*|*/caddy|*/caddy:*) printf 'caddy-docker|контейнер %s (Caddy)|%s|%s\n' "$name" "$name" "$2" ;;
        *remnawave/node*|*xray*|*sing-box*|*hysteria*|*3x-ui*|*marzban-node*|*marzneshin*)
            printf 'vpn|контейнер %s — VPN|%s|%s\n' "$name" "$name" "$2" ;;
        *) printf 'other|контейнер %s|%s|%s\n' "$name" "$name" "$2" ;;
    esac
}

# Кто держит порт: «вид|подпись|контейнер|образ». Вид: free, own (сама панель), nginx, caddy, caddy-docker,
# vpn, other. Порт, проброшенный Docker без docker-proxy, процесса не имеет — его видно по контейнерам.
port_holder() {
    local proto=$1 port=$2 lis name="" pid="" ctr=""
    lis=$(port_listener "$proto" "$port")
    if [[ -z $lis ]]; then
        ctr=$(container_on_port "$port" "$proto")
        [[ -n $ctr ]] || { printf 'free|свободен||\n'; return; }
    else
        name=${lis%%$'\t'*}
        pid=${lis#*$'\t'}
        if [[ $name == docker-proxy ]]; then
            ctr=$(container_on_port "$port" "$proto")
        elif [[ -n $pid ]]; then
            ctr=$(container_of_pid "$pid")
        fi
    fi
    if [[ -n $ctr ]]; then
        local cname cimage
        IFS=$'\t' read -r cname cimage _ <<<"$ctr"
        classify_container "$cname" "$cimage"
    else
        classify_process "$name"
    fi
}
holder_kind()  { printf '%s\n' "${1%%|*}"; }
holder_label() { local r=${1#*|}; printf '%s\n' "${r%%|*}"; }
holder_name()  { local r=${1#*|}; r=${r#*|}; printf '%s\n' "${r%%|*}"; }

# Свободный порт TCP (и UDP при $3=udp) из диапазона $1..$2.
free_port() {
    local p
    for (( p = $1; p <= $2; p++ )); do
        [[ -n $(ss -H -ltn "sport = :$p" 2>/dev/null) ]] && continue
        [[ ${3:-} == udp && -n $(ss -H -lun "sport = :$p" 2>/dev/null) ]] && continue
        printf '%s\n' "$p"
        return 0
    done
    return 1
}

# --- Внутренняя сеть: панель без домена, только по внутреннему адресу ---

# Адреса IPv4 сервера, кроме сетей Docker: «интерфейс<TAB>адрес» по строке.
local_ipv4s() {
    ip -4 -o addr show scope global 2>/dev/null |
        awk '{ split($4, a, "/"); print $2 "\t" a[1] }' |
        grep -vE '^(docker[0-9]*|br-[0-9a-f]+|veth[^[:space:]]*)[[:space:]]' || true
}

# Адрес IPv4: четыре числа 0–255.
is_ipv4() {
    local IFS=. n
    [[ $1 =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]] || return 1
    for n in $1; do (( 10#$n <= 255 )) || return 1; done
}

# Внутренний адрес: 10.*, 172.16–31.*, 192.168.*, 100.64–127.* (Tailscale, NAT провайдера).
is_private_ipv4() {
    is_ipv4 "$1" || return 1
    [[ $1 =~ ^10\. || $1 =~ ^192\.168\. || $1 =~ ^172\.(1[6-9]|2[0-9]|3[01])\. ||
        $1 =~ ^100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\. ]]
}

# Внутренний адрес по умолчанию: прежний ($1), если он ещё есть у сервера, иначе первый внутренний.
default_internal_addr() {
    local addrs a
    addrs=$(local_ipv4s | cut -f2)
    if [[ -n ${1:-} ]] && grep -qxF "$1" <<<"$addrs"; then
        printf '%s\n' "$1"
        return 0
    fi
    while read -r a; do
        if [[ -n $a ]] && is_private_ipv4 "$a"; then
            printf '%s\n' "$a"
            return 0
        fi
    done <<<"$addrs"
    return 0
}

# Порт панели во внутренней сети: 80, если свободен, иначе первый свободный из 8080–8099.
internal_port() {
    if [[ $(holder_kind "$(port_holder tcp 80)") == free ]]; then
        printf '80\n'
        return 0
    fi
    free_port 8080 8099
}

# Адрес панели во внутренней сети: http://адрес, порт — если не 80.
internal_url() {
    if [[ $2 == 80 ]]; then printf 'http://%s\n' "$1"; else printf 'http://%s:%s\n' "$1" "$2"; fi
}

# Открыть адрес панели во внутренней сети ($1 — http://адрес[:порт]) так же, как браузер.
# VERIFY_STATE: ok, refused (никто не слушает), http (отвечает не панель), timeout, other.
verify_internal() {
    local url=$1 tries=${2:-6} i rc code body
    body=$(mktemp)
    VERIFY_STATE=timeout
    VERIFY_DETAIL=""
    for (( i = 1; i <= tries; i++ )); do
        rc=0
        code=$(curl -sS --max-time 8 -o "$body" -w '%{http_code}' "$url/api/health/live" 2>"$body.err") || rc=$?
        case $rc in
            0)
                if [[ $code == 200 ]] && grep -q '"status":"ok"' "$body"; then
                    VERIFY_STATE=ok
                    rm -f "$body" "$body.err"
                    return 0
                fi
                VERIFY_STATE=http
                VERIFY_DETAIL="код ответа $code"
                ;;
            7) VERIFY_STATE=refused ;;
            28) VERIFY_STATE=timeout ;;
            *)
                VERIFY_STATE=other
                VERIFY_DETAIL=$(head -c 200 "$body.err")
                ;;
        esac
        (( i < tries )) && sleep "${NODESERVICE_VERIFY_PAUSE:-5}"
    done
    rm -f "$body" "$body.err"
    return 1
}

# --- nginx ---

NGINX_DUMP=""
nginx_dump() {
    [[ -n $NGINX_DUMP ]] || NGINX_DUMP=$(nginx -T 2>/dev/null || true)
    printf '%s\n' "$NGINX_DUMP"
}
nginx_version() { nginx -v 2>&1 | sed -n 's#.*nginx/\([0-9][0-9.]*\).*#\1#p' | head -n 1; }

# Все «server_name …;» строки, даже несколько в одной строке («server { listen 80; server_name a.com; }»):
# «файл<TAB>имя» для каждого имени. Файл — из пометок nginx -T «# configuration file путь:».
nginx_names() {
    nginx_dump | awk '
        /^# configuration file / { f = $4; sub(/:$/, "", f); next }
        {
            line = $0
            while (match(line, /(^|[;{[:space:]])server_name[[:space:]]+[^;]+;/)) {
                part = substr(line, RSTART, RLENGTH); line = substr(line, RSTART + RLENGTH)
                sub(/^.*server_name[[:space:]]+/, "", part); sub(/;$/, "", part)
                n = split(part, names, /[[:space:]]+/)
                for (i = 1; i <= n; i++) if (names[i] != "") print f "\t" names[i]
            }
        }'
}

# Имена сайтов (server_name) без «_» и localhost.
nginx_sites() {
    nginx_names | cut -f2 | grep -vE '^(_|localhost|)$' | sort -u
}

# Файл, где уже есть сайт с этим именем (nginx -T пишет «# configuration file путь:» перед каждым файлом).
# $2 — свой файл панели: его не считаем.
nginx_conflict_file() {
    nginx_names | awk -F'\t' -v d="$1" -v skip="${2:-}" '$2 == d && $1 != skip { print $1; exit }'
}

# Все имена сайтов одного файла — чтобы не отключить вместе с ним чужие сайты.
nginx_file_names() {
    nginx_names | awk -F'\t' -v want="$1" '$1 == want && $2 != "_" { print $2 }' | sort -u
}

# Куда положить сайт: «файл<TAB>ссылка» (ссылка пуста для conf.d). Код 1 — nginx не подключает ни sites-enabled, ни conf.d.
nginx_site_paths() {
    local dir=${NGINX_DIR:-/etc/nginx}
    if grep -qE "include[[:space:]]+$dir/sites-enabled/" <<<"$(nginx_dump)" && [[ -d $dir/sites-enabled ]]; then
        printf '%s\t%s\n' "$dir/sites-available/nodeservice" "$dir/sites-enabled/nodeservice"
    elif grep -qE "include[[:space:]]+$dir/conf\.d/\*\.conf" <<<"$(nginx_dump)"; then
        printf '%s\t\n' "$dir/conf.d/nodeservice.conf"
    else
        return 1
    fi
}

# http2: с nginx 1.25.1 — отдельной строкой «http2 on», раньше — параметром listen.
nginx_http2_style() {
    local v=${1:-0}
    if [[ $(printf '%s\n' 1.25.1 "$v" | sort -V | head -n 1) == 1.25.1 ]]; then printf 'new\n'; else printf 'old\n'; fi
}

# IPv6 в listen — только если nginx уже слушает IPv6 и он есть на сервере: иначе nginx не запустится.
nginx_uses_ipv6() {
    [[ -f /proc/net/if_inet6 ]] && grep -qE 'listen[[:space:]]+\[::' <<<"$(nginx_dump)"
}

# Сайт панели для nginx. $1 домен, $2 адрес панели (127.0.0.1:3080), $3 этап: http — только проверка
# Let’s Encrypt и переход на https; https — полностью. $4 — IPv6 (1/0), $5 — http2: new/old, $6/$7 — сертификат
# и ключ, $8 — адрес для listen (пусто — все адреса).
nginx_conf() {
    local d=$1 up=$2 phase=$3 v6=$4 h2=$5 crt=${6:-} key=${7:-} addr=${8:-} h2l=""
    local l80=${addr:+$addr:}80 l443=${addr:+$addr:}443
    printf '%s\n' "# NodeService — сайт панели. Добавлен установщиком; убрать: nodeservice uninstall." \
        "server {" "    listen $l80;"
    (( v6 )) && printf '%s\n' "    listen [::]:80;"
    printf '%s\n' "    server_name $d;" \
        "    # Проверка Let’s Encrypt, остальное — на https." \
        "    location /.well-known/acme-challenge/ { root $ACME_ROOT; }" \
        "    location / { return 301 https://\$host\$request_uri; }" \
        "}"
    [[ $phase == https ]] || return 0
    [[ $h2 == old ]] && h2l=" http2"
    printf '%s\n' "server {" "    listen $l443 ssl$h2l;"
    (( v6 )) && printf '%s\n' "    listen [::]:443 ssl$h2l;"
    [[ $h2 == new ]] && printf '%s\n' "    http2 on;"
    printf '%s\n' "    server_name $d;" \
        "    ssl_certificate $crt;" \
        "    ssl_certificate_key $key;" \
        "    ssl_protocols TLSv1.2 TLSv1.3;" \
        "    add_header Strict-Transport-Security \"max-age=31536000; includeSubDomains\" always;" \
        "    add_header X-Content-Type-Options \"nosniff\" always;" \
        "    add_header X-Frame-Options \"DENY\" always;" \
        "    add_header Referrer-Policy \"strict-origin-when-cross-origin\" always;" \
        "    # Загрузка копии панели — до 2 ГБ и сразу в панель." \
        "    client_max_body_size 2g;" \
        "    location / {" \
        "        proxy_pass http://$up;" \
        "        proxy_http_version 1.1;" \
        "        proxy_set_header Host \$host;" \
        "        proxy_set_header X-Real-IP \$remote_addr;" \
        "        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;" \
        "        proxy_set_header X-Forwarded-Proto \$scheme;" \
        "        proxy_set_header Connection \"\";" \
        "        # Живой журнал и события панели идут потоком: без буфера и с долгим ожиданием." \
        "        proxy_buffering off;" \
        "        proxy_request_buffering off;" \
        "        proxy_read_timeout 1h;" \
        "        proxy_send_timeout 1h;" \
        "    }" \
        "}"
}

# Файл и строка из ошибки nginx -t: «… in /etc/nginx/sites-enabled/shop.conf:14» → «/etc/…/shop.conf 14».
nginx_error_where() { sed -n 's/.* in \(\/[^ :]*\):\([0-9]\{1,\}\).*/\1 \2/p' <<<"$1" | head -n 1; }
# Строка ошибки без даты и номера процесса: «[emerg] unknown directive "proxy_pas" in …:14».
nginx_error_line() {
    grep -m 1 -E '\[(emerg|alert|crit|error)\]' <<<"$1" |
        sed -E 's/^nginx: //; s/^[0-9\/]+ [0-9:]+ (\[[a-z]+\]) [0-9#]+: /\1 /' | cut -c1-160
}

nginx_reload() {
    if systemctl is-active --quiet nginx 2>/dev/null; then systemctl reload nginx; else nginx -s reload; fi
}

# --- Caddy ---

caddy_version() { caddy version 2>/dev/null | sed -n 's/^v\{0,1\}\([0-9][0-9.]*\).*/\1/p' | head -n 1; }

# Caddyfile службы caddy: из ExecStart (--config …), по умолчанию /etc/caddy/Caddyfile.
caddy_unit_config() {
    local exec
    exec=$(systemctl show -p ExecStart caddy 2>/dev/null || true)
    if [[ $exec =~ --config[[:space:]]+([^[:space:]\;]+) ]]; then printf '%s\n' "${BASH_REMATCH[1]}"; else printf '/etc/caddy/Caddyfile\n'; fi
}

# Имена сайтов из настроек Caddy (через caddy adapt; $@ — команда caddy, например «docker exec имя caddy»).
caddy_sites_from() {
    "$@" 2>/dev/null | grep -o '"host":\[[^]]*\]' | grep -o '"[^"]*"' | tr -d '"' | grep -vx host | sort -u
}

# Есть ли в тексте Caddyfile (вне блока панели) сайт с этим именем: адрес верхнего уровня перед «{».
caddyfile_has_site() {
    local file=$1 d=$2 re
    re=${d//./\\.}
    awk -v start="$MARK_START" -v end="$MARK_END" '$0 == start { skip = 1 } !skip { print } $0 == end { skip = 0 }' "$file" |
        grep -vE '^[[:space:]]*#' | grep -qE "(^|[[:space:],])(https?://)?$re(:[0-9]+)?([[:space:],{]|$)"
}

# Блок сайта панели для Caddy: те же заголовки, что у собственного Caddy панели, поток без буфера.
caddy_site_block() {
    printf '%s\n' "$1 {" \
        "	encode zstd gzip" \
        "	header {" \
        "		Strict-Transport-Security \"max-age=31536000; includeSubDomains\"" \
        "		X-Content-Type-Options \"nosniff\"" \
        "		X-Frame-Options \"DENY\"" \
        "		Referrer-Policy \"strict-origin-when-cross-origin\"" \
        "		-Server" \
        "	}" \
        "	reverse_proxy $2 {" \
        "		flush_interval -1" \
        "		header_up X-Real-IP {remote_host}" \
        "	}" \
        "}"
}

# Заменить блок между метками или дописать его в конец — на месте, тем же файлом: Caddyfile, смонтированный
# в контейнер отдельным файлом, после «mv» контейнер бы не увидел. Пустой $2 — только убрать блок.
marker_block_set() {
    local file=$1 block=${2:-} tmp
    tmp=$(mktemp)
    awk -v start="$MARK_START" -v end="$MARK_END" '$0 == start { skip = 1; next } $0 == end { skip = 0; next } !skip' "$file" >"$tmp"
    if [[ -n $block ]]; then
        # Пустые строки в конце — одна, перед блоком.
        sed -i -e :a -e '/^\n*$/{$d;N;ba' -e '}' "$tmp"
        printf '\n%s\n%s\n%s\n' "$MARK_START" "$block" "$MARK_END" >>"$tmp"
    fi
    cat "$tmp" >"$file"
    rm -f "$tmp"
}

# Подключить/убрать файл с сайтом панели строкой import в конце Caddyfile (запись на месте).
caddy_import_set() {
    local cf=$1 file=$2 tmp
    grep -qxF "import $file" "$cf" && return 0
    printf '\n%s\n%s\n' "$CADDY_IMPORT_NOTE" "import $file" >>"$cf"
}
caddy_import_unset() {
    local cf=$1 file=$2 tmp
    tmp=$(mktemp)
    grep -vxF -e "$CADDY_IMPORT_NOTE" -e "import $file" "$cf" >"$tmp" || true
    cat "$tmp" >"$cf"
    rm -f "$tmp"
}

# Caddyfile контейнера на сервере: «путь на сервере<TAB>путь в контейнере».
docker_caddyfile() {
    local mounts
    mounts=$(docker inspect -f '{{range .Mounts}}{{.Source}}{{"\t"}}{{.Destination}}{{"\n"}}{{end}}' "$1" 2>/dev/null) || return 1
    awk -F'\t' '
        $2 == "/etc/caddy/Caddyfile" { print $1 "\t" $2; found = 1; exit }
        $2 == "/etc/caddy" { dir = $1 }
        END { if (!found && dir != "") print dir "/Caddyfile\t/etc/caddy/Caddyfile" }' <<<"$mounts"
}
docker_networks() {
    docker inspect -f '{{range $k, $v := .NetworkSettings.Networks}}{{$k}}{{"\n"}}{{end}}' "$1" 2>/dev/null |
        grep -vxE '(bridge|host|none|)' || true
}
docker_netmode() { docker inspect -f '{{.HostConfig.NetworkMode}}' "$1" 2>/dev/null; }
docker_bridge_gateway() {
    docker network inspect bridge -f '{{range .IPAM.Config}}{{.Gateway}}{{end}}' 2>/dev/null | head -n 1
}

# --- Сертификаты ---

# Сертификат Let’s Encrypt, подходящий к домену (точное имя или *.родитель) и действующий ещё неделю:
# «fullchain<TAB>privkey<TAB>дата окончания».
le_cert_for() {
    local d=$1 dir crt names end
    for dir in "${LE_LIVE_DIR:-/etc/letsencrypt/live}"/*/; do
        crt="${dir}fullchain.pem"
        [[ -f $crt && -f ${dir}privkey.pem ]] || continue
        openssl x509 -checkend 604800 -noout -in "$crt" >/dev/null 2>&1 || continue
        names=$(openssl x509 -noout -ext subjectAltName -in "$crt" 2>/dev/null | tr ',' '\n' | sed -n 's/.*DNS:\([^ ]*\).*/\1/p')
        if grep -qxF "$d" <<<"$names" || grep -qxF "*.${d#*.}" <<<"$names"; then
            end=$(openssl x509 -noout -enddate -in "$crt" | cut -d= -f2)
            printf '%s\t%s\t%s\n' "$crt" "${dir}privkey.pem" "$end"
            return 0
        fi
    done
    return 1
}

# Причина отказа certbot по-русски.
certbot_reason() {
    local out=$1
    if grep -qiE 'NXDOMAIN|No valid IP addresses|DNS problem' <<<"$out"; then
        printf 'домен не найден в DNS или указывает не сюда — проверьте A-запись у регистратора\n'
    elif grep -qiE 'too many|rateLimited|rate limit' <<<"$out"; then
        printf 'Let’s Encrypt временно ограничил выпуск для этого домена — повторите установку через час\n'
    elif grep -qiE 'Timeout during connect|Connection refused|Fetching .* Timeout|firewall' <<<"$out"; then
        printf 'Let’s Encrypt не смог зайти на сервер по порту 80 — проверьте брандмауэр у хостера\n'
    elif grep -qiE 'unauthorized|Invalid response|404' <<<"$out"; then
        printf 'по адресу домена отвечает другой сервер — проверьте A-запись домена\n'
    else
        printf 'Let’s Encrypt не выдал сертификат\n'
    fi
}

# Дата окончания сертификата, который сервер отдаёт для домена (как её пишет openssl).
tls_enddate() {
    local ip
    for ip in 127.0.0.1 ${PUBLIC_IP:-}; do
        echo | timeout 10 openssl s_client -connect "$ip:$2" -servername "$1" 2>/dev/null |
            openssl x509 -noout -enddate 2>/dev/null | cut -d= -f2 | grep . && return 0
    done
    return 1
}

# Открыть https://домен/api/health/live так, как откроет браузер — с проверкой сертификата, — но соединяясь
# с этим сервером (127.0.0.1, затем внешний адрес): DNS и NAT хостера не мешают. VERIFY_STATE: ok, tls
# (сертификата ещё нет или он чужой), refused (никто не слушает), http (отвечает не панель), timeout.
verify_panel() {
    local d=$1 p=$2 tries=${3:-30} i ip code rc body
    body=$(mktemp)
    VERIFY_STATE=timeout
    VERIFY_DETAIL=""
    for (( i = 1; i <= tries; i++ )); do
        for ip in 127.0.0.1 ${PUBLIC_IP:-}; do
            rc=0
            code=$(curl -sS --max-time 8 --resolve "$d:$p:$ip" -o "$body" -w '%{http_code}' \
                "https://$d:$p/api/health/live" 2>"$body.err") || rc=$?
            case $rc in
                0)
                    if [[ $code == 200 ]] && grep -q '"status":"ok"' "$body"; then
                        VERIFY_STATE=ok
                        rm -f "$body" "$body.err"
                        return 0
                    fi
                    VERIFY_STATE=http
                    VERIFY_DETAIL="код ответа $code"
                    break
                    ;;
                7) VERIFY_STATE=refused ;;
                28) VERIFY_STATE=timeout ;;
                35|51|53|54|58|59|60|64|66|77|80|82|83|90|91)
                    VERIFY_STATE=tls
                    VERIFY_DETAIL=$(head -c 200 "$body.err")
                    break
                    ;;
                *)
                    VERIFY_STATE=other
                    VERIFY_DETAIL=$(head -c 200 "$body.err")
                    ;;
            esac
        done
        (( i < tries )) && sleep "${NODESERVICE_VERIFY_PAUSE:-5}"
    done
    rm -f "$body" "$body.err"
    return 1
}

# --- infra/.env ---

env_get() { [[ -f $ENV_FILE ]] && grep -E "^$1=" "$ENV_FILE" | tail -n 1 | cut -d= -f2- || true; }
env_set() {
    if grep -qE "^$1=" "$ENV_FILE"; then sed -i "s|^$1=.*|$1=$2|" "$ENV_FILE"; else printf '%s=%s\n' "$1" "$2" >>"$ENV_FILE"; fi
}
env_unset() { sed -i "/^$1=/d" "$ENV_FILE"; }

# Убрать сайт панели из вашего nginx или Caddy (nodeservice uninstall и смена способа). Ваши сайты не трогает.
proxy_remove() {
    local mode file link cf ctr inner
    mode=$(env_get PANEL_PROXY)
    case "$mode" in
        nginx)
            file=$(env_get PANEL_PROXY_FILE)
            link=$(env_get PANEL_PROXY_LINK)
            [[ -n $link ]] && rm -f "$link"
            [[ -n $file ]] && rm -f "$file"
            if nginx -t >/dev/null 2>&1; then nginx_reload >/dev/null 2>&1 || true; fi
            ;;
        caddy)
            cf=$(env_get PANEL_PROXY_CADDYFILE)
            file=$(env_get PANEL_PROXY_FILE)
            [[ -f $cf && -n $file ]] && caddy_import_unset "$cf" "$file"
            [[ -n $file ]] && rm -f "$file"
            systemctl reload caddy >/dev/null 2>&1 || true
            ;;
        caddy-docker)
            cf=$(env_get PANEL_PROXY_CADDYFILE)
            ctr=$(env_get PANEL_PROXY_CONTAINER)
            inner=$(env_get PANEL_PROXY_INNER)
            [[ -f $cf ]] && marker_block_set "$cf" ""
            [[ -n $ctr ]] && docker exec "$ctr" caddy reload --config "${inner:-/etc/caddy/Caddyfile}" --adapter caddyfile >/dev/null 2>&1 || true
            ;;
    esac
    return 0
}

# Сборка/скачивание кода: последний прошедший CI релиз, а не промежуточный main.
latest_release_tag() {
    local repo="${NODESERVICE_PANEL_REPO:-feauche/nodeservice-panel}" body tag
    body=$(curl -fsSL --connect-timeout 5 --max-time 15 \
        -H 'Accept: application/vnd.github+json' -H 'X-GitHub-Api-Version: 2022-11-28' \
        "https://api.github.com/repos/$repo/releases/latest") || return 1
    tag=$(sed -n 's/^[[:space:]]*"tag_name":[[:space:]]*"\([^"]*\)".*/\1/p' <<<"$body" | head -n 1)
    [[ "$tag" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || return 1
    printf '%s\n' "$tag"
}

# NODESERVICE_REF=main оставляет явный тестовый режим; NODESERVICE_BRANCH сохранён для старых команд.
checkout_source_ref() {
    local ref="$SOURCE_REF" target=""
    # --force: метку, перенесённую на GitHub (выпуск переделан), без него git не обновляет и падает.
    git -C "$APP_DIR" fetch --quiet --tags --force origin || return 1
    if [[ "$ref" == "latest" ]]; then
        ref=${RELEASE_TAG:-$(latest_release_tag)} || return 1
    fi
    if git -C "$APP_DIR" rev-parse --verify --quiet "origin/$ref^{commit}" >/dev/null; then
        target="origin/$ref"
    elif git -C "$APP_DIR" rev-parse --verify --quiet "$ref^{commit}" >/dev/null; then
        target="$ref"
    else
        return 1
    fi
    git -C "$APP_DIR" checkout --quiet --detach "$target" || return 1
    CODE_REF=$ref
}

if [[ -n "${NODESERVICE_INSTALL_LIB:-}" ]]; then return 0 2>/dev/null || exit 0; fi

# ===================================================== Установка =====================================================

set -euo pipefail

REPO_SSH="${NODESERVICE_REPO_SSH:-git@github.com:feauche/nodeservice-panel.git}"
REPO_HTTPS="${NODESERVICE_REPO_HTTPS:-https://github.com/feauche/nodeservice-panel.git}"
SOURCE_REF="${NODESERVICE_REF:-${NODESERVICE_BRANCH:-latest}}"
APP_DIR="${NODESERVICE_DIR:-/opt/nodeservice}"
export NODESERVICE_DIR="$APP_DIR"
DEPLOY_KEY="/root/.ssh/nodeservice_deploy"
ENV_FILE="$APP_DIR/infra/.env"
export GIT_TERMINAL_PROMPT=0
COMPOSE=(docker compose -f "$APP_DIR/infra/compose.yaml" --env-file "$ENV_FILE")

RESTORE_FILE=""
while [[ $# -gt 0 ]]; do
    case "$1" in
        --restore) RESTORE_FILE="${2:-}"; shift 2 ;;
        -h|--help) sed -n '2,23p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *) echo "Неизвестный параметр: $1 (поддерживается --restore <файл бэкапа>)" >&2; exit 1 ;;
    esac
done

[[ $EUID -eq 0 ]] || die "Запустите от root."
command -v apt-get >/dev/null || die "Поддерживаются только Debian и Ubuntu."
if locale -a 2>/dev/null | grep -qiE '^c\.utf-?8$'; then export LC_ALL=C.UTF-8; fi
mkdir -p "$(dirname "$LOG")" && : >>"$LOG" && chmod 600 "$LOG" || LOG=/dev/null
log "=== установщик запущен"
command -v ss >/dev/null || { apt-get update -qq >>"$LOG" 2>&1; apt-get install -y -qq iproute2 >>"$LOG" 2>&1 || true; }

RELEASE_TAG=""
[[ $SOURCE_REF == latest ]] && RELEASE_TAG=$(latest_release_tag 2>/dev/null || true)
CODE_REF=""

printf '\n%s %s\n\n' "${A}◆ NodeService${N}" "${D}— установка панели${RELEASE_TAG:+ · ${RELEASE_TAG#v}}${N}"

# --- Параметры: способ открытия, домен и почта или внутренний адрес (повторный запуск — из .env, переезд — из копии) ---

# Как открывать панель. ACCESS: domain — по домену из интернета (https, сертификат); internal — только во
# внутренней сети по адресу сервера (http, без домена и сертификата). $1 — пункт по умолчанию, $2 — прежний
# внутренний адрес (переезд). Без вопросов: NODESERVICE_ADDRESS — внутренняя сеть, NODESERVICE_DOMAIN — домен.
ACCESS=domain INTERNAL_ADDR="" INTERNAL_PORT="" PANEL_URL="" PORT_MOVED=""
ask_access() {
    local def=$1 addrs addr a public=0 private="" n
    addrs=$(local_ipv4s | cut -f2)
    addr=${NODESERVICE_ADDRESS:-$(default_internal_addr "${2:-}")}
    if [[ -n ${NODESERVICE_ADDRESS:-} ]]; then
        ACCESS=internal
    elif [[ -n ${NODESERVICE_DOMAIN:-} ]]; then
        ACCESS=domain
        return 0
    else
        while read -r a; do
            [[ -n $a ]] || continue
            if is_private_ipv4 "$a"; then private+="${private:+, }$a"; else public=1; fi
        done <<<"$addrs"
        if (( ! public )) && [[ -n $private ]]; then
            say "${D}У сервера только внутренние адреса ($private) — если панель нужна только внутри сети, выберите 2.${N}"
        fi
        n=$(choose "Как будете открывать панель?" "$def" \
            "по домену из интернета: https://panel.example.com — сертификат панель получит сама" \
            "только во внутренней сети: http://${addr:-10.0.0.2} — без домена и сертификата; снаружи — через VPN или проброс порта по SSH")
        echo
        if [[ $n == 1 ]]; then
            ACCESS=domain
            return 0
        fi
        ACCESS=internal
    fi
    while true; do
        INTERNAL_ADDR=$(ask "Адрес панели во внутренней сети" "$addr")
        if ! is_ipv4 "$INTERNAL_ADDR"; then
            say "${Y}«$INTERNAL_ADDR» — не адрес IPv4. Пример: 10.10.10.104${N}"
        elif ! grep -qxF "$INTERNAL_ADDR" <<<"$addrs"; then
            a=$(grep . <<<"$addrs" | paste -sd, - | sed 's/,/, /g' || true)
            say "${Y}Адреса $INTERNAL_ADDR нет у этого сервера.${N} Его адреса: ${a:-не нашёл ни одного}."
        else
            break
        fi
        [[ -z ${NODESERVICE_YES:-} ]] || die "Адрес панели не подошёл: «$INTERNAL_ADDR». Я ничего не менял."
        addr=""
    done
    # Адрес VPN (Tailscale, WireGuard): после перезагрузки он появляется позже Docker, и панель может не встать.
    a=$(local_ipv4s | awk -F'\t' -v ip="$INTERNAL_ADDR" '$2 == ip { print $1; exit }')
    if [[ $a =~ ^(tailscale|wg|tun|zt|ts) ]]; then
        say "${Y}!${N} Это адрес VPN ($a): после перезагрузки сервера он появляется позже Docker, и панель может не запуститься сама. Тогда выполните: nodeservice start. Надёжнее — адрес сетевой карты сервера."
    fi
    if ! is_private_ipv4 "$INTERNAL_ADDR"; then
        yesno "Адрес $INTERNAL_ADDR — внешний: панель будет открыта из интернета без шифрования. Всё равно поставить?" n \
            "Для внешнего адреса надёжнее установка по домену — с сертификатом." ||
            die "Установка отменена — я ничего не менял."
    fi
}

RESTORE_ENV="" RERUN=0 INSTALLED_VERSION=""
if [[ -n "$RESTORE_FILE" ]]; then
    [[ -f "$RESTORE_FILE" ]] || die "Файл бэкапа не найден: $RESTORE_FILE"
    RESTORE_FILE=$(readlink -f "$RESTORE_FILE")
    [[ -f "$ENV_FILE" ]] && die "Панель уже установлена в $APP_DIR. Восстановление поверх: nodeservice restore $RESTORE_FILE"
    RESTORE_WORK=$(mktemp -d /tmp/nodeservice-restore-env.XXXXXX); chmod 700 "$RESTORE_WORK"
    if [[ "$(head -c 8 "$RESTORE_FILE")" == "Salted__" ]]; then
        # Копия из панели с паролем: расшифровываем один раз, дальше работаем с обычным архивом.
        command -v openssl >/dev/null || die "Для копии с паролем нужен openssl: apt-get install -y openssl"
        # Расшифрованный архив живёт до конца восстановления (restore.sh), потом удаляется.
        RESTORE_PLAIN=$(mktemp /tmp/nodeservice-restore-XXXXXX.tar.gz); chmod 600 "$RESTORE_PLAIN"
        trap 'rm -f "$RESTORE_PLAIN"' EXIT
        pw="${NODESERVICE_BACKUP_PASSWORD:-}"
        [[ -n "$pw" ]] || { read -rsp "Пароль архива: " pw </dev/tty; echo; }
        PASS="$pw" openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -md sha256 -pass env:PASS \
            -in "$RESTORE_FILE" -out "$RESTORE_PLAIN" 2>/dev/null || die "Пароль не подошёл (или файл повреждён)."
        unset pw
        RESTORE_FILE="$RESTORE_PLAIN"
    fi
    tar -C "$RESTORE_WORK" -xzf "$RESTORE_FILE" env meta 2>/dev/null || die "Это не бэкап панели (ожидается nodeservice-backup-*.tar.gz от nodeservice backup)."
    RESTORE_ENV="$RESTORE_WORK/env"
    [[ -f "$RESTORE_WORK/meta" ]] && { say "Копия:"; sed 's/^/     /' "$RESTORE_WORK/meta"; echo; }
    # Способ, домен или адрес по умолчанию — прежние: закладки и ссылки на панель продолжат открываться.
    old_domain=$(grep -E '^PANEL_DOMAIN=' "$RESTORE_ENV" | cut -d= -f2- || true)
    old_email=$(grep -E '^ACME_EMAIL=' "$RESTORE_ENV" | cut -d= -f2- || true)
    # Панель стояла во внутренней сети: «домен» в копии — её внутренний адрес (копия из панели способ не
    # хранит, консольная — хранит PANEL_PROXY).
    old_bind="" access_def=1
    if grep -qxE 'PANEL_PROXY=internal' "$RESTORE_ENV" || is_ipv4 "$old_domain"; then
        access_def=2
        old_bind=$(grep -E '^PANEL_LOCAL_BIND=' "$RESTORE_ENV" | cut -d= -f2- || true)
        old_bind=${old_bind:-$old_domain}
        old_domain=""
    fi
    ask_access "$access_def" "$old_bind"
    if [[ $ACCESS == domain ]]; then
        PANEL_DOMAIN=$(ask "Домен панели (по умолчанию — прежний)" "${NODESERVICE_DOMAIN:-${old_domain:-}}")
        [[ "$PANEL_DOMAIN" =~ ^[a-z0-9.-]+\.[a-z]{2,}$ ]] || die "Некорректный домен: «$PANEL_DOMAIN»."
        [[ -n "$old_domain" && "$PANEL_DOMAIN" != "$old_domain" ]] && warn "Домен меняется: старые закладки и ссылки на панель перестанут открываться."
        ACME_EMAIL=$(ask "Почта для сертификатов" "${NODESERVICE_EMAIL:-${old_email:-admin@${PANEL_DOMAIN#*.}}}")
    fi
elif [[ -f "$ENV_FILE" ]]; then
    RERUN=1
    PANEL_DOMAIN=$(env_get PANEL_DOMAIN)
    ACME_EMAIL=$(env_get ACME_EMAIL)
    INSTALLED_VERSION=$(env_get NODESERVICE_VERSION)
    if [[ $(env_get PANEL_PROXY) == internal ]]; then
        ACCESS=internal
        INTERNAL_ADDR=$(env_get PANEL_LOCAL_BIND)
    fi
    say "Найдена установка: ${B}$PANEL_DOMAIN${N}${INSTALLED_VERSION:+, версия ${INSTALLED_VERSION#v}}."
else
    ask_access 1
    if [[ $ACCESS == domain ]]; then
        PANEL_DOMAIN=$(ask "Домен панели (A-запись должна указывать на этот сервер)" "${NODESERVICE_DOMAIN:-}")
        [[ "$PANEL_DOMAIN" =~ ^[a-z0-9.-]+\.[a-z]{2,}$ ]] || die "Некорректный домен: «$PANEL_DOMAIN». Пример: panel.example.com"
        ACME_EMAIL=$(ask "Почта для сертификатов" "${NODESERVICE_EMAIL:-admin@${PANEL_DOMAIN#*.}}")
    fi
fi
# Во внутренней сети домена нет: «домен» панели — её внутренний адрес, почта для сертификатов не нужна.
if [[ $ACCESS == internal ]]; then
    PANEL_DOMAIN=$INTERNAL_ADDR
    ACME_EMAIL=""
fi
echo

# --- Сводка: что есть на сервере ---

t0=$SECONDS
printf '%s' "Смотрю, что есть на сервере… "
# shellcheck disable=SC1091
OS_NAME=$( . /etc/os-release 2>/dev/null && printf '%s %s' "${NAME%% *}" "${VERSION_ID:-}" || true )
CORES=$(nproc 2>/dev/null || echo 1)
MEM_MB=$(awk '/MemTotal/ {print int($2/1024)}' /proc/meminfo)
SWAP_MB=$(awk '/SwapTotal/ {print int($2/1024)}' /proc/meminfo)
DISK_GB=$(free_disk_gb)
# Сборка образа на сервере (pnpm install + vite + nest build): при < 3.5 ГБ RAM+swap падает по OOM.
NEED_SWAP=0
(( MEM_MB + SWAP_MB < 3500 )) && [[ ! -f /swapfile ]] && NEED_SWAP=1
DOCKER_VER=""
if command -v docker >/dev/null && docker compose version >/dev/null 2>&1; then
    DOCKER_VER=$(docker version --format '{{.Server.Version}}' 2>/dev/null | cut -d. -f1-2 || true)
fi
PUBLIC_IP=$(curl -fsS4 --max-time 8 https://api.ipify.org 2>/dev/null || true)
RESOLVED=$(getent ahostsv4 "$PANEL_DOMAIN" 2>/dev/null | awk '{print $1}' | sort -u | tr '\n' ' ' || true)
RESOLVED=${RESOLVED% }
H80=$(port_holder tcp 80)
H443=$(port_holder tcp 443)
H443U=$(port_holder udp 443)
K80=$(holder_kind "$H80") K443=$(holder_kind "$H443") K443U=$(holder_kind "$H443U")
NGINX_VER="" NGINX_SITES=""
if command -v nginx >/dev/null; then
    NGINX_VER=$(nginx_version || true)
    NGINX_SITES=$(nginx_sites | grep -vxF "$PANEL_DOMAIN" || true)
fi
CADDY_VER="" CADDYFILE="" CADDY_SITES=""
if command -v caddy >/dev/null; then
    CADDY_VER=$(caddy_version || true)
    CADDYFILE=$(caddy_unit_config)
    [[ -f $CADDYFILE ]] && CADDY_SITES=$(caddy_sites_from caddy adapt --config "$CADDYFILE" --adapter caddyfile | grep -vxF "$PANEL_DOMAIN" || true)
fi
DC_NAME="" DC_FILE="" DC_INNER="" DC_NET="" DC_MODE="" DC_SITES=""
for h in "$H443" "$H80"; do
    if [[ $(holder_kind "$h") == caddy-docker ]]; then
        DC_NAME=$(holder_name "$h")
        IFS=$'\t' read -r DC_FILE DC_INNER < <(docker_caddyfile "$DC_NAME" || true) || true
        DC_NET=$(docker_networks "$DC_NAME" | head -n 1)
        DC_MODE=$(docker_netmode "$DC_NAME" || true)
        DC_SITES=$(caddy_sites_from docker exec "$DC_NAME" caddy adapt --config "${DC_INNER:-/etc/caddy/Caddyfile}" --adapter caddyfile |
            grep -vxF "$PANEL_DOMAIN" || true)
        break
    fi
done
LE_CERT=$(le_cert_for "$PANEL_DOMAIN" 2>/dev/null || true)
UFW_ACTIVE=0
command -v ufw >/dev/null && ufw status 2>/dev/null | grep -q "Status: active" && UFW_ACTIVE=1
printf '%s\n\n' "${D}$(( SECONDS - t0 )) с${N}"

# Сайты одним списком: «3: a.com, b.com, ещё 1».
sites_text() {
    local list=$1 n first
    n=$(grep -c . <<<"$list" || true)
    (( n == 0 )) && { printf 'сайтов пока нет\n'; return; }
    first=$(head -n 2 <<<"$list" | paste -sd, - | sed 's/,/, /g')
    if (( n > 2 )); then printf 'сайтов %s: %s, ещё %s\n' "$n" "$first" "$(( n - 2 ))"; else printf 'сайтов %s: %s\n' "$n" "$first"; fi
}

# --- Способ открыть панель ---
# MODE: bundled — свой Caddy на 80/443; port — свой Caddy на 80 и 8443 (нода с VPN на 443); nginx, caddy —
# сайт в вашем веб-сервере; caddy-docker — сайт в Caddy из контейнера; stop — установить нельзя.

MODE="" STOP_REASON="" PANEL_HTTPS_PORT=443 H3_OFF=0 STOP_TARGET="" STOP_LABEL=""
NGINX_FILE="" NGINX_LINK="" NGINX_REPLACE="" CERT_SOURCE="" OWN_CRT="" OWN_KEY=""
PREV_MODE=$(env_get PANEL_PROXY)
is_free() { [[ $1 == free || $1 == own ]]; }
F80=0 F443=0
is_free "$K80" && F80=1
is_free "$K443" && F443=1
# Веб-сервер держит 443 — или 80, когда 443 свободен.
web_on() { [[ $K443 == "$1" ]] || { [[ $K80 == "$1" ]] && (( F443 )); }; }

if [[ $ACCESS == internal ]]; then
    MODE=internal
elif (( F80 && F443 )); then
    MODE=bundled
elif web_on nginx; then
    MODE=nginx
elif web_on caddy; then
    MODE=caddy
elif web_on caddy-docker; then
    MODE=caddy-docker
elif [[ $K443 == vpn ]] && (( F80 )); then
    MODE=port
elif [[ $K443 != vpn && $K80 != vpn ]] && [[ $K443 == other || $K80 == other ]]; then
    MODE=other
else
    MODE=stop
    STOP_REASON="Порт 443 занимает $(holder_label "$H443"), а порт 80 — $(holder_label "$H80"). Свой веб-сервер панели здесь не запустить, а сертификат не получить. Поставьте панель на отдельный сервер."
fi
# UDP 443 занят (Hysteria2 и т. п.), а TCP свободен: свой Caddy работает без HTTP/3.
if [[ $MODE == bundled ]] && ! is_free "$K443U"; then H3_OFF=1; fi
# Порт во внутренней сети: при повторном запуске — прежний (его держит сама панель), иначе 80 или свободный.
if [[ $MODE == internal ]]; then
    if (( RERUN )) && [[ $PREV_MODE == internal && -n $(env_get PANEL_LOCAL_PORT) ]]; then
        INTERNAL_PORT=$(env_get PANEL_LOCAL_PORT)
        h=$(port_holder tcp "$INTERNAL_PORT")
        if ! is_free "$(holder_kind "$h")"; then
            # Пока панель стояла, прежний порт заняла другая программа — панель переезжает на свободный.
            PORT_MOVED="$INTERNAL_PORT|$(holder_label "$h")"
            INTERNAL_PORT=$(internal_port) || die "Порт $INTERNAL_PORT занят ($(holder_label "$h")), а других свободных нет: 80 и 8080–8099. Я ничего не менял."
        fi
    elif [[ -n ${NODESERVICE_PORT:-} ]]; then
        [[ $NODESERVICE_PORT =~ ^[0-9]+$ ]] && (( NODESERVICE_PORT >= 1 && NODESERVICE_PORT <= 65535 )) ||
            die "Порт «$NODESERVICE_PORT» — не число от 1 до 65535. Я ничего не менял."
        h=$(port_holder tcp "$NODESERVICE_PORT")
        [[ $(holder_kind "$h") == free ]] || die "Порт $NODESERVICE_PORT занят: $(holder_label "$h"). Я ничего не менял."
        INTERNAL_PORT=$NODESERVICE_PORT
    else
        INTERNAL_PORT=$(internal_port) || die "Нет свободного порта для панели: заняты 80 и 8080–8099. Я ничего не менял."
    fi
    PANEL_URL=$(internal_url "$INTERNAL_ADDR" "$INTERNAL_PORT")
fi

# --- Сводка на экран ---

mem_text="$(gb "$MEM_MB") ГБ памяти" disk_text="свободно ${DISK_GB:-?} ГБ"
srv_mark=ok
if (( MEM_MB < MIN_MEM_MB )); then
    srv_mark=warn
    mem_text+=" — меньше нужного 1 ГБ"
    (( NEED_SWAP )) && mem_text+=", добавлю 2 ГБ подкачки, но панели может не хватить"
elif (( NEED_SWAP )); then
    srv_mark=warn
    mem_text+=" — мало, добавлю 2 ГБ подкачки"
fi
if [[ $DISK_GB =~ ^[0-9]+$ ]] && (( DISK_GB < MIN_DISK_GB )); then
    srv_mark=warn
    disk_text+=" — мало, нужно от $MIN_DISK_GB ГБ"
fi
row "$srv_mark" "Сервер" "${OS_NAME:-Linux} · $(plural "$CORES" ядро ядра ядер) · $mem_text · $disk_text"
if [[ -n $DOCKER_VER ]]; then row ok "Docker" "есть, $DOCKER_VER"; else row info "Docker" "нет — поставлю"; fi
DNS_OK=0
if [[ $MODE == internal ]]; then
    if is_private_ipv4 "$INTERNAL_ADDR"; then
        row ok "Адрес" "$PANEL_URL — только внутренняя сеть, из интернета не открыть"
    else
        row warn "Адрес" "$PANEL_URL — внешний адрес, без шифрования"
    fi
    if [[ -n $PORT_MOVED ]]; then
        row busy "Порт ${PORT_MOVED%%|*}" "занят: ${PORT_MOVED#*|} — панель переедет на $INTERNAL_PORT"
        row ok "Порт $INTERNAL_PORT" "свободен"
    elif [[ $(holder_kind "$(port_holder tcp "$INTERNAL_PORT")") == own ]]; then
        row ok "Порт $INTERNAL_PORT" "занят самой панелью — так и должно быть"
    else
        (( INTERNAL_PORT == 80 )) || [[ $(holder_kind "$H80") == free ]] || row busy "Порт 80" "занят: $(holder_label "$H80")"
        row ok "Порт $INTERNAL_PORT" "свободен"
    fi
elif [[ -n $PUBLIC_IP && " $RESOLVED " == *" $PUBLIC_IP "* ]]; then
    DNS_OK=1
    row ok "Домен" "$PANEL_DOMAIN → $PUBLIC_IP, это этот сервер"
elif [[ -z $RESOLVED ]]; then
    row warn "Домен" "$PANEL_DOMAIN не найден в DNS — сертификат не выпустится, пока не добавите A-запись${PUBLIC_IP:+ на $PUBLIC_IP}"
else
    row warn "Домен" "$PANEL_DOMAIN указывает на $RESOLVED, а у сервера ${PUBLIC_IP:-другой адрес} — сертификат не выпустится, пока не исправите A-запись"
fi
port_row() {
    local h=$1 key=$2 kind
    kind=$(holder_kind "$h")
    case $kind in
        free) row ok "$key" "свободен" ;;
        own) row ok "$key" "занят самой панелью — так и должно быть" ;;
        *) row busy "$key" "занят: $(holder_label "$h")" ;;
    esac
}
if [[ $MODE != internal ]]; then
    port_row "$H80" "Порт 80"
    port_row "$H443" "Порт 443"
    port_row "$H443U" "443 UDP"
fi
if [[ $MODE != internal && -n $NGINX_VER ]]; then
    row info "nginx" "$NGINX_VER · $(systemctl is-active --quiet nginx 2>/dev/null && echo работает || echo остановлен) · $(sites_text "$NGINX_SITES")"
fi
if [[ $MODE != internal && -n $CADDY_VER ]]; then
    row info "Caddy" "$CADDY_VER · $(systemctl is-active --quiet caddy 2>/dev/null && echo работает || echo остановлен) · $(sites_text "$CADDY_SITES")"
fi
if [[ $MODE != internal && -n $DC_NAME ]]; then
    row info "Caddy" "в контейнере $DC_NAME · $(sites_text "$DC_SITES")"
fi
case $MODE in
    bundled) [[ $K443 == own ]] && row ok "Сертификат" "есть, панель продлевает сама" || row ok "Сертификат" "панель получит сама" ;;
    caddy|caddy-docker) row ok "Сертификат" "Caddy выпустит сам" ;;
    port) row ok "Сертификат" "получу через свободный порт 80" ;;
    nginx)
        if [[ -n $LE_CERT ]]; then
            row ok "Сертификат" "есть, до $(ru_date "$(cut -f3 <<<"$LE_CERT")" short)"
        else
            row no "Сертификат" "для $PANEL_DOMAIN нет · certbot $(command -v certbot >/dev/null && echo есть || echo 'не установлен')"
        fi
        ;;
esac
if (( UFW_ACTIVE )); then row ok "Брандмауэр" "UFW включён — открою нужные порты"; else row info "Брандмауэр" "выключен"; fi
echo

# --- Вывод простыми словами и вопросы ---

stop_install() {
    say "${R}✗ $1${N}"
    say "  Я ничего не менял."
    exit 1
}

case $MODE in
    bundled)
        if (( RERUN )); then
            say "Это повторный запуск: обновлю код и перезапущу панель. Данные и настройки сохраню, способ открытия — прежний (свой веб-сервер)."
        else
            say "Порты свободны — панель поставит свой веб-сервер и сама получит сертификат. Осталось только подтвердить начало."
        fi
        (( H3_OFF )) && say "UDP 443 занят — панель будет работать без HTTP/3, на скорость это почти не влияет."
        ;;
    internal)
        if (( RERUN )) && [[ -n $PORT_MOVED ]]; then
            say "Это повторный запуск: обновлю код и перезапущу панель. Данные и настройки сохраню. Прежний порт ${PORT_MOVED%%|*} занят — новый адрес панели: ${B}$PANEL_URL${N}."
        elif (( RERUN )); then
            say "Это повторный запуск: обновлю код и перезапущу панель. Данные и настройки сохраню, адрес прежний: $PANEL_URL."
        else
            say "Панель будет работать только во внутренней сети: ${B}$PANEL_URL${N}. Домен и сертификат не нужны. Уведомления в Telegram, Remnawave и проверки работают как обычно — панель сама выходит в интернет."
        fi
        ;;
    nginx)
        if ! command -v nginx >/dev/null; then stop_install "Порты держит nginx в необычной установке — его настройки не найти. Поставьте панель на отдельный сервер."; fi
        nginx_t=$(nginx -t 2>&1) || {
            where=$(nginx_error_where "$nginx_t")
            say "${R}✗ Настройки nginx не проходят проверку ещё до моих изменений.${N}"
            [[ -n $where ]] && say "  Ошибка в файле ${where% *}, строка ${where##* }."
            say "  Я ничего не менял и nginx не перезагружал — ваши сайты работают как раньше."
            say "  Что сделать: исправьте этот файл и запустите установку снова."
            say "  ${D}Текст nginx для поддержки: $(nginx_error_line "$nginx_t")${N}"
            exit 1
        }
        IFS=$'\t' read -r NGINX_FILE NGINX_LINK < <(nginx_site_paths || true) || true
        [[ -n $NGINX_FILE ]] || stop_install "nginx не подключает ни папку sites-enabled, ни conf.d — некуда добавить сайт. Поставьте панель на отдельный сервер."
        if [[ $PREV_MODE == nginx && -f $NGINX_FILE ]]; then
            say "Порты держит ваш ${B}nginx${N}, сайт панели в нём уже есть — обновлю его. Ваши сайты не трогаю."
        else
            say "Порты 80 и 443 занимает ваш ${B}nginx${N}. Панель встанет рядом: добавлю в nginx отдельный сайт ${B}$PANEL_DOMAIN${N}, ваши сайты не трогаю."
            echo
            yesno "Добавить сайт панели в nginx?" y || stop_install "Установка отменена."
        fi
        conflict=$(nginx_conflict_file "$PANEL_DOMAIN" "$NGINX_FILE")
        if [[ -n $conflict ]]; then
            others=$(nginx_file_names "$conflict" | grep -vxF "$PANEL_DOMAIN" || true)
            [[ -z $others ]] || stop_install "В nginx уже есть сайт $PANEL_DOMAIN в файле $conflict вместе с другими сайтами. Уберите из него $PANEL_DOMAIN или выберите другой домен и запустите установку снова."
            echo
            say "${Y}!${N} В nginx уже есть сайт ${B}$PANEL_DOMAIN${N} — файл $conflict. Два сайта с одним именем nginx не различит."
            yesno "Заменить старый сайт сайтом панели? Старый файл сохраню." y || stop_install "Установка отменена."
            NGINX_REPLACE=$conflict
        fi
        echo
        if [[ -n $LE_CERT ]]; then
            if yesno "Нашёл сертификат для $PANEL_DOMAIN (до $(ru_date "$(cut -f3 <<<"$LE_CERT")")). Использовать его?" y; then
                CERT_SOURCE=existing
                OWN_CRT=$(cut -f1 <<<"$LE_CERT") OWN_KEY=$(cut -f2 <<<"$LE_CERT")
            fi
        fi
        if [[ -z $CERT_SOURCE ]]; then
            if yesno "Получить бесплатный сертификат Let’s Encrypt для $PANEL_DOMAIN?" y "Поставлю certbot — продлевать сертификат он будет сам."; then
                CERT_SOURCE=letsencrypt
            else
                say "Без сертификата панель не откроется: вход требует защищённого соединения."
                OWN_CRT=$(ask "Путь к файлу сертификата (полная цепочка)" "")
                OWN_KEY=$(ask "Путь к файлу ключа" "")
                [[ -f $OWN_CRT && -f $OWN_KEY ]] || stop_install "Файлы сертификата не найдены."
                [[ "$(openssl x509 -noout -pubkey -in "$OWN_CRT" 2>/dev/null | sha256sum)" == "$(openssl pkey -pubout -in "$OWN_KEY" 2>/dev/null | sha256sum)" ]] ||
                    stop_install "Ключ не подходит к сертификату."
                CERT_SOURCE=own
            fi
        fi
        ;;
    caddy)
        [[ -f $CADDYFILE ]] || stop_install "Порты держит Caddy, но его файл настроек не найден (ожидался $CADDYFILE). Поставьте панель на отдельный сервер."
        if caddyfile_has_site "$CADDYFILE" "$PANEL_DOMAIN"; then
            stop_install "В вашем Caddy уже есть сайт $PANEL_DOMAIN (файл $CADDYFILE). Уберите его или выберите другой домен и запустите установку снова."
        fi
        if [[ $PREV_MODE == caddy ]]; then
            say "Порты держит ваш ${B}Caddy${N}, сайт панели в нём уже есть — обновлю его. Ваши сайты не трогаю."
        else
            say "Порты занимает ваш ${B}Caddy${N}. Панель встанет рядом: добавлю в Caddy сайт ${B}$PANEL_DOMAIN${N}, сертификат Caddy получит сам. Ваши сайты не трогаю."
            echo
            yesno "Добавить сайт панели в ваш Caddy?" y || stop_install "Установка отменена."
        fi
        ;;
    caddy-docker)
        [[ -n $DC_FILE && -f $DC_FILE ]] || stop_install "Порты держит Caddy в контейнере $DC_NAME, но его файл настроек не лежит на сервере — добавить сайт некуда. Поставьте панель на отдельный сервер."
        if caddyfile_has_site "$DC_FILE" "$PANEL_DOMAIN"; then
            stop_install "В Caddy из контейнера $DC_NAME уже есть сайт $PANEL_DOMAIN (файл $DC_FILE). Уберите его или выберите другой домен и запустите установку снова."
        fi
        if [[ $PREV_MODE == caddy-docker ]]; then
            say "Порты держит ${B}Caddy в контейнере «$DC_NAME»${N}, сайт панели в нём уже есть — обновлю его."
        else
            say "Порты занимает ${B}Caddy в контейнере «$DC_NAME»${N}. Панель встанет рядом: подключу её к сети этого контейнера и добавлю сайт в его настройки. Сертификат Caddy получит сам."
            echo
            yesno "Добавить сайт панели в Caddy из контейнера «$DC_NAME»?" y || stop_install "Установка отменена."
        fi
        ;;
    port)
        if [[ $PREV_MODE == port && -n $(env_get PANEL_HTTPS_PORT) ]]; then
            # Повторный запуск: порт уже выбран и занят самой панелью — адрес панели не меняем.
            PANEL_HTTPS_PORT=$(env_get PANEL_HTTPS_PORT)
            say "Порт 443 занимает ${B}VPN${N}, панель стоит рядом на порту $PANEL_HTTPS_PORT — обновлю её, адрес не изменится."
        else
            say "Порт 443 занимает ${B}VPN${N} — это нода. Надёжнее поставить панель на отдельный сервер: если нода упадёт или её заблокируют, панель не сможет об этом сообщить. Здесь панель встанет только на другой порт — VPN не трогаю."
            echo
            PANEL_HTTPS_PORT=$(free_port 8443 8499 udp) || stop_install "Нет свободного порта для панели в диапазоне 8443–8499."
            yesno "Всё же поставить здесь, на порт $PANEL_HTTPS_PORT?" n "Адрес будет https://$PANEL_DOMAIN:$PANEL_HTTPS_PORT, сертификат получу через свободный порт 80." ||
                stop_install "Установка отменена — поставьте панель на отдельный сервер."
        fi
        ;;
    other)
        hb=$H443
        [[ $K443 == other ]] || hb=$H80
        STOP_LABEL=$(holder_label "$hb")
        say "Порты 80 и 443 занимает ${B}$STOP_LABEL${N}. Встать рядом с этой программой панель не умеет — её настройки бывают очень разными."
        echo
        yesno "Остановить $STOP_LABEL и поставить панель на 80 и 443?" n "Всё, что сейчас работает через эту программу, перестанет открываться." ||
            stop_install "Установка остановлена до сборки. Поставьте панель на отдельный сервер или освободите порты и запустите установку снова."
        if [[ -n $(holder_name "$hb") ]]; then
            STOP_TARGET="docker:$(holder_name "$hb")"
        else
            pid=$(port_listener tcp 443 | cut -f2)
            [[ -n $pid ]] || pid=$(port_listener tcp 80 | cut -f2)
            unit=$(ps -o unit= -p "$pid" 2>/dev/null | tr -d ' ' || true)
            [[ $unit == *.service ]] || stop_install "Не нашёл, как остановить $STOP_LABEL: это не служба systemd. Остановите программу сами и запустите установку снова."
            STOP_TARGET="unit:$unit"
        fi
        MODE=bundled
        is_free "$K443U" || H3_OFF=1
        ;;
    stop)
        stop_install "$STOP_REASON"
        ;;
esac
echo

# --- Что сделаю ---

PANEL_LOCAL_PORT=""
case $MODE in
    nginx|caddy)
        PANEL_LOCAL_PORT=$(env_get PANEL_LOCAL_PORT)
        [[ -n $PANEL_LOCAL_PORT ]] || PANEL_LOCAL_PORT=$(free_port 3080 3199) || stop_install "Нет свободного внутреннего порта 3080–3199."
        ;;
    caddy-docker)
        if [[ -z $DC_NET && $DC_MODE != host ]]; then
            PANEL_LOCAL_PORT=$(env_get PANEL_LOCAL_PORT)
            [[ -n $PANEL_LOCAL_PORT ]] || PANEL_LOCAL_PORT=$(free_port 3080 3199) || stop_install "Нет свободного внутреннего порта 3080–3199."
        elif [[ $DC_MODE == host ]]; then
            PANEL_LOCAL_PORT=$(env_get PANEL_LOCAL_PORT)
            [[ -n $PANEL_LOCAL_PORT ]] || PANEL_LOCAL_PORT=$(free_port 3080 3199) || stop_install "Нет свободного внутреннего порта 3080–3199."
        fi
        ;;
esac
URL_SUFFIX=""
(( PANEL_HTTPS_PORT != 443 )) && URL_SUFFIX=":$PANEL_HTTPS_PORT"
[[ $MODE == internal ]] || PANEL_URL="https://$PANEL_DOMAIN$URL_SUFFIX"

PLAN=()
STEPS=()
[[ -n $STOP_TARGET ]] && { PLAN+=("Остановлю $STOP_LABEL и отключу его автозапуск"); STEPS+=("Остановка $STOP_LABEL|step_stop_other"); }
[[ -z $DOCKER_VER ]] && { PLAN+=("Поставлю Docker"); STEPS+=("Docker|step_docker"); }
(( NEED_SWAP )) && { PLAN+=("Добавлю 2 ГБ подкачки — для сборки"); STEPS+=("Подкачка|step_swap"); }
if (( RERUN )); then
    PLAN+=("Обновлю код панели${RELEASE_TAG:+ до ${RELEASE_TAG#v}}")
else
    PLAN+=("Скачаю код панели${RELEASE_TAG:+ — версия ${RELEASE_TAG#v}}")
fi
STEPS+=("Код панели|step_code")
case $MODE in
    bundled)
        PLAN+=("Соберу и запущу панель (3–8 минут) с её веб-сервером на портах 80 и 443")
        STEPS+=("Сборка и запуск панели|step_build")
        [[ $K443 == own ]] || PLAN+=("Получу сертификат для $PANEL_DOMAIN, продление — само")
        STEPS+=("Сертификат|step_cert_wait")
        ;;
    internal)
        PLAN+=("Соберу и запущу панель (3–8 минут) — слушает только адрес $INTERNAL_ADDR, порт $INTERNAL_PORT")
        STEPS+=("Сборка и запуск панели|step_build")
        ;;
    port)
        PLAN+=("Соберу и запущу панель (3–8 минут) с её веб-сервером на портах 80 и $PANEL_HTTPS_PORT — VPN не трогаю")
        PLAN+=("Получу сертификат через порт 80, продление — само")
        STEPS+=("Сборка и запуск панели|step_build" "Сертификат|step_cert_wait")
        ;;
    nginx)
        PLAN+=("Соберу и запущу панель (3–8 минут) — слушает только внутри сервера, порт $PANEL_LOCAL_PORT")
        [[ -n $NGINX_REPLACE ]] && PLAN+=("Отключу старый сайт $PANEL_DOMAIN — файл $NGINX_REPLACE сохраню")
        PLAN+=("Сохраню копию настроек nginx, добавлю сайт $PANEL_DOMAIN и перезагружу nginx — сайты не остановятся, настройки проверю до и после")
        case $CERT_SOURCE in
            letsencrypt)
                if command -v certbot >/dev/null; then PLAN+=("Получу сертификат Let’s Encrypt, продление — само")
                else PLAN+=("Поставлю certbot и получу сертификат Let’s Encrypt, продление — само"); fi
                ;;
            existing) PLAN+=("Возьму найденный сертификат") ;;
            own) PLAN+=("Возьму ваш сертификат: $OWN_CRT") ;;
        esac
        PLAN+=("Включу https для сайта панели")
        STEPS+=("Сборка и запуск панели|step_build" "Сайт в nginx|step_nginx_site" "Сертификат|step_nginx_cert" "Https для сайта|step_nginx_https")
        ;;
    caddy)
        PLAN+=("Соберу и запущу панель (3–8 минут) — слушает только внутри сервера, порт $PANEL_LOCAL_PORT")
        PLAN+=("Сохраню копию $CADDYFILE и подключу к нему файл с сайтом панели")
        PLAN+=("Проверю настройки Caddy и перезагружу его — сайты не остановятся")
        STEPS+=("Сборка и запуск панели|step_build" "Сайт в Caddy|step_caddy_site" "Сертификат|step_cert_wait")
        ;;
    caddy-docker)
        PLAN+=("Соберу и запущу панель (3–8 минут)")
        if [[ -n $DC_NET ]]; then
            PLAN+=("Подключу панель к сети $DC_NET — только для связи с Caddy")
        else
            PLAN+=("Открою панель для Caddy на внутреннем порту $PANEL_LOCAL_PORT")
        fi
        PLAN+=("Сохраню копию $DC_FILE и добавлю сайт панели")
        PLAN+=("Проверю настройки внутри контейнера и перезагружу Caddy — сайты не остановятся")
        STEPS+=("Сборка и запуск панели|step_build" "Связь с Caddy|step_docker_link" "Сайт в Caddy|step_docker_site" "Сертификат|step_cert_wait")
        ;;
esac
PLAN+=("Проверю, что $PANEL_URL открывает панель")
if [[ $MODE == internal ]]; then STEPS+=("Проверка адреса|step_verify"); else STEPS+=("Проверка https|step_verify"); fi
if [[ -n $RESTORE_FILE ]]; then
    PLAN+=("Восстановлю данные из копии")
    STEPS+=("Восстановление данных|step_restore")
fi

say "${B}Что сделаю:${N}"
i=0
for p in "${PLAN[@]}"; do i=$((i + 1)); wrap_words "$i. $p" 2 "" 5; done
echo
yesno "Начать?" y || { say "Установка отменена — я ничего не менял."; exit 0; }
echo

# --- Шаги ---

STEP_I=0
STEP_TOTAL=${#STEPS[@]}
STEP_RESULT="" STEP_SHORT="" STEP_FAIL="" STEP_WARN="" STEP_DETAIL=""

step_line() {
    local i=$1 n=$2 label=$3 right=$4 w left dots n_dots
    w=$(term_width)
    left="[$i/$n] $label"
    n_dots=$(( w - $(vis_len "$left") - $(vis_len "$right") - 2 ))
    (( n_dots < 2 )) && n_dots=2
    printf -v dots '%*s' "$n_dots" ''
    dots=${dots// /·}
    printf '%s %s %s %s\n' "${C}[$i/$n]${N}" "$label" "${D}$dots${N}" "$right"
}

# Шаг: подпись и функция. Функция пишет итог в STEP_RESULT; при ошибке — STEP_SHORT (коротко) и STEP_FAIL
# (объяснение), код 1; код 2 — «не до конца» (STEP_WARN), установка продолжается.
run_step() {
    local label=$1 fn=$2 start=$SECONDS tick="" rc=0
    STEP_I=$((STEP_I + 1))
    STEP_RESULT="" STEP_SHORT="" STEP_FAIL="" STEP_WARN="" STEP_DETAIL=""
    log "--- шаг $STEP_I: $label"
    if [[ -t 1 ]]; then
        (
            while :; do
                printf '\r\033[K%s %s %s' "${C}[$STEP_I/$STEP_TOTAL]${N}" "$label" "${D}$(dur $((SECONDS - start)))${N}"
                sleep 1
            done
        ) &
        tick=$!
    fi
    "$fn" || rc=$?
    if [[ -n $tick ]]; then
        kill "$tick" 2>/dev/null || true
        wait "$tick" 2>/dev/null || true
        printf '\r\033[K'
    fi
    case $rc in
        0) step_line "$STEP_I" "$STEP_TOTAL" "$label" "${STEP_RESULT:-готово}  ${G}✓${N}" ;;
        2) step_line "$STEP_I" "$STEP_TOTAL" "$label" "${STEP_SHORT:-не до конца}  ${Y}!${N}" ;;
        *) step_line "$STEP_I" "$STEP_TOTAL" "$label" "${STEP_SHORT:-не получилось}  ${R}✗${N}" ;;
    esac
    return "$rc"
}

fail_step() {
    echo
    say "${R}✗ ${STEP_FAIL:-Шаг не получился.}${N}"
    if [[ -n $STEP_DETAIL ]]; then
        say "${D}Причина — в журнале ($LOG):${N}" 2
        printf '  %s\n' "${D}${STEP_DETAIL}${N}"
    elif [[ -s $LOG && $LOG != /dev/null ]]; then
        say "${D}Последние строки журнала ($LOG):${N}" 2
        tail -n 12 "$LOG" | sed "s/^/  ${D}/; s/\$/${N}/"
    fi
    exit 1
}

step_stop_other() {
    case $STOP_TARGET in
        docker:*)
            docker update --restart=no "${STOP_TARGET#docker:}" >>"$LOG" 2>&1 || true
            docker stop "${STOP_TARGET#docker:}" >>"$LOG" 2>&1 || { STEP_FAIL="Не удалось остановить контейнер ${STOP_TARGET#docker:}."; return 1; }
            ;;
        unit:*)
            systemctl disable --now "${STOP_TARGET#unit:}" >>"$LOG" 2>&1 || { STEP_FAIL="Не удалось остановить ${STOP_TARGET#unit:}."; return 1; }
            ;;
    esac
    sleep 1
    if [[ -n $(port_listener tcp 443) || -n $(port_listener tcp 80) ]]; then
        STEP_FAIL="Порты 80 и 443 всё ещё заняты после остановки $STOP_LABEL."
        return 1
    fi
    STEP_RESULT="остановлен"
}

step_docker() {
    curl -fsSL https://get.docker.com -o /tmp/get-docker.sh >>"$LOG" 2>&1 || { STEP_FAIL="Не скачался установщик Docker (get.docker.com) — проверьте сеть."; return 1; }
    sh /tmp/get-docker.sh >>"$LOG" 2>&1 || { STEP_FAIL="Docker не поставился."; return 1; }
    rm -f /tmp/get-docker.sh
    systemctl enable --now docker >>"$LOG" 2>&1 || true
    DOCKER_VER=$(docker version --format '{{.Server.Version}}' 2>/dev/null | cut -d. -f1-2)
    STEP_RESULT="поставлен, ${DOCKER_VER:-?}"
}

step_swap() {
    if fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile >>"$LOG" 2>&1 && swapon /swapfile; then
        grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >>/etc/fstab
        STEP_RESULT="2 ГБ включено"
    else
        rm -f /swapfile
        STEP_SHORT="не вышло"
        STEP_WARN="Подкачку создать не удалось — сборка может упасть по нехватке памяти."
        return 2
    fi
}

# Код, .env, команда nodeservice, папка копий, брандмауэр — всё, что до сборки.
step_code() {
    local missing=() pkg
    for pkg in git openssl curl; do command -v "$pkg" >/dev/null || missing+=("$pkg"); done
    if (( ${#missing[@]} )); then
        { apt-get update -qq && apt-get install -y -qq ca-certificates "${missing[@]}"; } >>"$LOG" 2>&1 ||
            { STEP_FAIL="Не поставились пакеты: ${missing[*]}."; return 1; }
    fi
    if [[ ! -d "$APP_DIR/.git" ]]; then
        git clone --branch main --depth 1 "$CLONE_URL" "$APP_DIR" >>"$LOG" 2>&1 ||
            { STEP_FAIL="Код панели не скачался — проверьте доступ к GitHub."; return 1; }
        checkout_source_ref >>"$LOG" 2>&1 || { STEP_FAIL="Не нашёл версию «$SOURCE_REF» (для latest нужен релиз GitHub с тегом vX.Y.Z)."; return 1; }
    else
        [[ -f "$DEPLOY_KEY" ]] && export GIT_SSH_COMMAND="ssh -i $DEPLOY_KEY -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new"
        checkout_source_ref >>"$LOG" 2>&1 || log "код не обновился — продолжаю с тем, что есть"
    fi
    write_env || return 1
    write_proxy_env
    # Набор файлов compose зависит от способа: оверлей добавляет порт или сеть для вашего веб-сервера.
    if [[ -f "$APP_DIR/infra/scripts/compose-args.sh" ]]; then
        # shellcheck disable=SC1091
        . "$APP_DIR/infra/scripts/compose-args.sh"
        nodeservice_compose "$APP_DIR" "$ENV_FILE"
    fi
    install -m 0755 "$APP_DIR/infra/scripts/nodeservice" /usr/local/bin/nodeservice
    # Расписание копий — в панели («Настройки → Резервные копии», по умолчанию каждый день в 04:00).
    rm -f /etc/cron.d/nodeservice-backup
    # Папка копий — до запуска: иначе Docker создаст её от root, и панель не сможет туда писать.
    mkdir -p -m 700 "$APP_DIR/backups"
    chown 10001:10001 "$APP_DIR/backups"
    open_firewall
    STEP_RESULT="версия ${CODE_REF:-$(git -C "$APP_DIR" rev-parse --short HEAD)}"
    STEP_RESULT=${STEP_RESULT/версия v/версия }
}

envval() { grep -E "^$2=" "$1" 2>/dev/null | head -1 | cut -d= -f2- || true; }

write_env() {
    # Во внутренней сети почты для сертификатов нет — и строки в .env тоже.
    local email_line=${ACME_EMAIL:+ACME_EMAIL=$ACME_EMAIL}
    if [[ -n "$RESTORE_ENV" ]]; then
        # Секреты — из бэкапа (иначе TOTP, доступы к серверам и ключ панели не расшифровать),
        # домен/e-mail — что выбрали выше, версия кода — текущая.
        umask 077
        cat >"$ENV_FILE" <<ENV
# Восстановлено install.sh --restore $(date -u +%Y-%m-%dT%H:%MZ) из $(basename "$RESTORE_FILE"). Не коммитить.
# Бэкапь вместе с БД — без ENCRYPTION_KEY зашифрованные секреты не восстановить.
PANEL_DOMAIN=${PANEL_DOMAIN}
${email_line}
NODESERVICE_VERSION=$(git -C "$APP_DIR" rev-parse --short HEAD)
POSTGRES_PASSWORD=$(envval "$RESTORE_ENV" POSTGRES_PASSWORD)
APP_SECRET=$(envval "$RESTORE_ENV" APP_SECRET)
ENCRYPTION_KEY=$(envval "$RESTORE_ENV" ENCRYPTION_KEY)
ENCRYPTION_KEY_VERSION=$(envval "$RESTORE_ENV" ENCRYPTION_KEY_VERSION)
PASSWORD_PEPPER=$(envval "$RESTORE_ENV" PASSWORD_PEPPER)
ENV
        umask 022
        local k
        for k in POSTGRES_PASSWORD APP_SECRET ENCRYPTION_KEY; do
            [[ -n "$(envval "$ENV_FILE" $k)" ]] || { STEP_FAIL="В бэкапе нет $k — .env в архиве неполный."; return 1; }
        done
        # Прочие переменные из старого .env (например, PROVIDER_ICON_FALLBACK_URL) переносим как есть.
        grep -vE '^(#|$|PANEL_DOMAIN=|ACME_EMAIL=|NODESERVICE_VERSION=|POSTGRES_PASSWORD=|APP_SECRET=|ENCRYPTION_KEY=|ENCRYPTION_KEY_VERSION=|PASSWORD_PEPPER=|PANEL_)' \
            "$RESTORE_ENV" >>"$ENV_FILE" || true
        rm -rf "$RESTORE_WORK"
    elif [[ ! -f "$ENV_FILE" ]]; then
        umask 077
        cat >"$ENV_FILE" <<ENV
# Сгенерировано install.sh $(date -u +%Y-%m-%dT%H:%MZ). Не коммитить. Бэкапь вместе с БД —
# без ENCRYPTION_KEY зашифрованные секреты (TOTP, доступы к серверам) не восстановить.
PANEL_DOMAIN=${PANEL_DOMAIN}
${email_line}
NODESERVICE_VERSION=$(git -C "$APP_DIR" rev-parse --short HEAD)
POSTGRES_PASSWORD=$(openssl rand -hex 24)
APP_SECRET=$(openssl rand -hex 32)
ENCRYPTION_KEY=$(openssl rand -hex 32)
ENCRYPTION_KEY_VERSION=1
PASSWORD_PEPPER=$(openssl rand -hex 32)
ENV
        umask 022
    else
        env_set NODESERVICE_VERSION "$(git -C "$APP_DIR" rev-parse --short HEAD)"
    fi
}

# Способ открытия — в .env: по нему update, nodeservice и uninstall знают, какие файлы compose брать и что убрать.
write_proxy_env() {
    local k
    for k in PANEL_PROXY PANEL_LOCAL_PORT PANEL_LOCAL_BIND PANEL_PROXY_NETWORK PANEL_PROXY_FILE PANEL_PROXY_LINK \
        PANEL_PROXY_CADDYFILE PANEL_PROXY_CONTAINER PANEL_PROXY_INNER PANEL_HTTPS_PORT PANEL_URL_PORT PANEL_PROTOCOLS PANEL_H3_PORT \
        PANEL_PUBLIC_URL; do
        env_unset "$k"
    done
    env_set PANEL_PROXY "$MODE"
    case $MODE in
        internal)
            # compose.internal.yaml: api на внутреннем адресе, адрес панели — http.
            env_set PANEL_LOCAL_BIND "$INTERNAL_ADDR"
            env_set PANEL_LOCAL_PORT "$INTERNAL_PORT"
            env_set PANEL_PUBLIC_URL "$PANEL_URL"
            ;;
        bundled)
            if (( H3_OFF )); then env_set PANEL_PROTOCOLS "h1 h2"; env_set PANEL_H3_PORT 0; fi
            ;;
        port)
            env_set PANEL_HTTPS_PORT "$PANEL_HTTPS_PORT"
            env_set PANEL_URL_PORT ":$PANEL_HTTPS_PORT"
            ;;
        nginx)
            env_set PANEL_LOCAL_PORT "$PANEL_LOCAL_PORT"
            env_set PANEL_PROXY_FILE "$NGINX_FILE"
            [[ -n $NGINX_LINK ]] && env_set PANEL_PROXY_LINK "$NGINX_LINK"
            ;;
        caddy)
            env_set PANEL_LOCAL_PORT "$PANEL_LOCAL_PORT"
            env_set PANEL_PROXY_CADDYFILE "$CADDYFILE"
            env_set PANEL_PROXY_FILE "$(dirname "$CADDYFILE")/nodeservice.caddy"
            ;;
        caddy-docker)
            env_set PANEL_PROXY_CADDYFILE "$DC_FILE"
            env_set PANEL_PROXY_CONTAINER "$DC_NAME"
            env_set PANEL_PROXY_INNER "${DC_INNER:-/etc/caddy/Caddyfile}"
            if [[ -n $DC_NET ]]; then
                env_set PANEL_PROXY_NETWORK "$DC_NET"
            else
                env_set PANEL_LOCAL_PORT "$PANEL_LOCAL_PORT"
                [[ $DC_MODE == host ]] || env_set PANEL_LOCAL_BIND "$(docker_bridge_gateway)"
            fi
            ;;
    esac
}

open_firewall() {
    (( UFW_ACTIVE )) || return 0
    if [[ $MODE == internal ]]; then
        ufw allow proto tcp to "$INTERNAL_ADDR" port "$INTERNAL_PORT" comment 'nodeservice internal' >>"$LOG" 2>&1 || true
        return 0
    fi
    local https=$PANEL_HTTPS_PORT
    {
        ufw allow 80/tcp comment 'nodeservice http'
        ufw allow "$https/tcp" comment 'nodeservice https'
        [[ $MODE == bundled || $MODE == port ]] && ufw allow "$https/udp" comment 'nodeservice h3'
    } >>"$LOG" 2>&1 || true
}

# Где панель слушает для вашего веб-сервера: 127.0.0.1:порт, шлюз Docker или имя в общей сети.
panel_upstream() {
    local net bind
    net=$(env_get PANEL_PROXY_NETWORK)
    if [[ -n $net ]]; then printf 'nodeservice-api:3000\n'; return; fi
    bind=$(env_get PANEL_LOCAL_BIND)
    printf '%s:%s\n' "${bind:-127.0.0.1}" "$(env_get PANEL_LOCAL_PORT)"
}

wait_api_healthy() {
    local st=starting
    for _ in $(seq 1 60); do
        st=$(docker inspect -f '{{.State.Health.Status}}' nodeservice-api-1 2>/dev/null || echo starting)
        [[ "$st" == "healthy" ]] && return 0
        sleep 3
    done
    "${COMPOSE[@]}" logs --tail=80 api >>"$LOG" 2>&1 || true
    return 1
}

# Сборка не удалась: по её выводу в журнале (строки после $1) — понятная причина и что сделать вместо хвоста
# журнала. Виды причин — в build-failure.sh из кода панели (общий с update.sh); без него — как раньше.
build_failed() {
    local from=$(($1 + 1)) kind line
    STEP_SHORT="сборка не удалась" STEP_FAIL="Сборка панели не удалась."
    [[ -f "$APP_DIR/infra/scripts/build-failure.sh" && $LOG != /dev/null ]] || return 0
    # shellcheck disable=SC1091
    . "$APP_DIR/infra/scripts/build-failure.sh"
    # Вывод этой сборки читаем прямо из журнала, без копии: если кончилось место, копию не записать.
    kind=$(build_failure_kind <(tail -n +"$from" "$LOG"))
    if [[ $kind == other ]] && build_disk_low; then kind=disk; fi
    line=$(build_failure_line <(tail -n +"$from" "$LOG") "$kind")
    case $kind in
        memory)
            STEP_SHORT="не хватило памяти"
            case $(build_memory_verdict <(tail -n +"$from" "$LOG")) in
                limit) STEP_FAIL="Сборке панели не хватило памяти, хотя у сервера $(build_memory_text) — этого хватает. Значит, сборке тесно в её собственном пределе (2 ГБ): это ошибка панели, сообщите о ней." ;;
                cage) STEP_FAIL="Сборку остановила система: не хватило памяти, хотя сервер видит $(build_memory_text). Похоже, у машины или контейнера свой предел памяти меньше этого (например, контейнер LXC в Proxmox) — увеличьте его и запустите установку снова." ;;
                *) STEP_FAIL="Сборке панели не хватило памяти: у сервера $(build_memory_text). Нужно хотя бы 1 ГБ памяти и 2 ГБ подкачки (подкачку установщик добавляет сам), рекомендуется 2 ГБ памяти. Добавьте серверу памяти и запустите установку снова — сделанное повторно делаться не будет." ;;
            esac
            ;;
        disk)
            STEP_SHORT="нет места на диске"
            STEP_FAIL="Во время сборки закончилось место на диске (свободно $(free_disk_gb) ГБ), а для установки нужно от $MIN_DISK_GB ГБ свободного места. Освободите место и запустите установку снова."
            ;;
        network)
            STEP_SHORT="не скачалось"
            STEP_FAIL="Сборке не удалось скачать нужное из интернета: образ Node с Docker Hub или пакеты npm. Проверьте, что сервер выходит в интернет, и запустите установку снова; если Docker Hub временно ограничил скачивание — через час."
            ;;
    esac
    STEP_DETAIL=$line
}

step_build() {
    local start=$SECONDS img out
    export APP_COMMIT APP_BUILT_AT
    APP_COMMIT="$(git -C "$APP_DIR" rev-parse --short HEAD)"
    APP_BUILT_AT="$(date -u +%Y-%m-%d)"
    img=$("${COMPOSE[@]}" config --images 2>/dev/null | grep nodeservice-api || true)
    if [[ -n $img ]] && docker image inspect "$img" >/dev/null 2>&1; then
        log "образ $img уже собран — сборку пропускаю"
    else
        local mark
        mark=$(wc -l <"$LOG" 2>/dev/null || echo 0)
        "${COMPOSE[@]}" build api >>"$LOG" 2>&1 || { build_failed "$mark"; return 1; }
    fi
    # Сменили способ на «рядом с вашим веб-сервером» — свой Caddy больше не нужен.
    if [[ $MODE != bundled && $MODE != port ]]; then docker rm -f nodeservice-caddy-1 >>"$LOG" 2>&1 || true; fi
    out=$("${COMPOSE[@]}" up -d --remove-orphans 2>&1) || true
    printf '%s\n' "$out" >>"$LOG"
    if [[ $MODE == internal ]] && grep -qiE 'cannot assign requested address' <<<"$out"; then
        STEP_SHORT="нет адреса"
        STEP_FAIL="Адреса $INTERNAL_ADDR нет у этого сервера — он сменился? Поправьте PANEL_LOCAL_BIND и PANEL_PUBLIC_URL в $ENV_FILE и запустите установку снова."
        return 1
    fi
    if [[ $MODE == internal ]] && grep -qiE 'address already in use|port is already allocated' <<<"$out"; then
        STEP_SHORT="порт занят"
        STEP_FAIL="Панель не запустилась: порт $INTERNAL_PORT на $INTERNAL_ADDR занят другой программой. Освободите его или запустите установку снова — она подберёт свободный порт."
        return 1
    fi
    if ! wait_api_healthy; then
        STEP_SHORT="не запустилась"
        STEP_FAIL="Панель собралась, но не запустилась (статус: $(docker inspect -f '{{.State.Health.Status}}' nodeservice-api-1 2>/dev/null || echo нет))."
        return 1
    fi
    if [[ $MODE == bundled || $MODE == port ]] &&
        [[ "$(docker inspect -f '{{.State.Running}}' nodeservice-caddy-1 2>/dev/null)" != true ]]; then
        STEP_SHORT="веб-сервер не запустился"
        if grep -qiE 'address already in use|port is already allocated' <<<"$out"; then
            STEP_FAIL="Веб-сервер панели не запустился: порт 80 или $PANEL_HTTPS_PORT занят другой программой."
        else
            STEP_FAIL="Веб-сервер панели (Caddy) не запустился."
        fi
        return 1
    fi
    STEP_RESULT=$(dur $((SECONDS - start)))
}

step_nginx_site() {
    local up conf v6=0 h2 addr
    up=$(panel_upstream)
    nginx_uses_ipv6 && v6=1
    h2=$(nginx_http2_style "$(nginx_version)")
    addr=$(listen_address 443)
    [[ -n $addr ]] || addr=$(listen_address 80)
    NGINX_ADDR=$addr NGINX_V6=$v6 NGINX_H2=$h2
    mkdir -p "$ACME_ROOT/.well-known/acme-challenge"
    # Копия прежнего сайта панели (повторный запуск) и отключение старого сайта с тем же именем.
    [[ -f $NGINX_FILE ]] && cp -p "$NGINX_FILE" "$NGINX_FILE.nodeservice.bak"
    if [[ -n $NGINX_REPLACE ]]; then
        if [[ -L $NGINX_REPLACE ]]; then
            cp -P "$NGINX_REPLACE" "$NGINX_REPLACE.nodeservice-off" && rm -f "$NGINX_REPLACE"
        else
            mv "$NGINX_REPLACE" "$NGINX_REPLACE.nodeservice-off"
        fi
    fi
    conf=$(nginx_conf "$PANEL_DOMAIN" "$up" http "$v6" "$h2" "" "" "$addr")
    printf '%s\n' "$conf" >"$NGINX_FILE"
    [[ -n $NGINX_LINK ]] && ln -sfn "$NGINX_FILE" "$NGINX_LINK"
    NGINX_DUMP=""
    local t
    if ! t=$(nginx -t 2>&1); then
        printf '%s\n' "$t" >>"$LOG"
        nginx_undo
        STEP_SHORT="не принят"
        STEP_FAIL="nginx не принял сайт панели — вернул прежние настройки, ваши сайты работают как раньше. $(nginx_error_line "$t")"
        return 1
    fi
    nginx_reload >>"$LOG" 2>&1 || { nginx_undo; STEP_SHORT="не перезагрузился"; STEP_FAIL="nginx не перезагрузился — вернул прежние настройки."; return 1; }
    STEP_RESULT="настройки приняты"
}

nginx_undo() {
    if [[ -f "$NGINX_FILE.nodeservice.bak" ]]; then mv -f "$NGINX_FILE.nodeservice.bak" "$NGINX_FILE"; else rm -f "$NGINX_FILE"; [[ -n $NGINX_LINK ]] && rm -f "$NGINX_LINK"; fi
    if [[ -n $NGINX_REPLACE && -e "$NGINX_REPLACE.nodeservice-off" ]]; then mv -f "$NGINX_REPLACE.nodeservice-off" "$NGINX_REPLACE"; fi
    nginx -t >/dev/null 2>&1 && nginx_reload >/dev/null 2>&1 || true
}

step_nginx_cert() {
    local out end
    case $CERT_SOURCE in
        existing|own)
            end=$(openssl x509 -noout -enddate -in "$OWN_CRT" | cut -d= -f2)
            STEP_RESULT="$([[ $CERT_SOURCE == own ]] && echo ваш || echo найденный), до $(ru_date "$end" short)"
            return 0
            ;;
    esac
    if ! command -v certbot >/dev/null; then
        { apt-get update -qq && apt-get install -y -qq certbot; } >>"$LOG" 2>&1 ||
            { STEP_SHORT="certbot не поставился"; STEP_FAIL="Не удалось поставить certbot."; return 1; }
    fi
    # shellcheck disable=SC2086
    if ! out=$(certbot certonly --webroot -w "$ACME_ROOT" -d "$PANEL_DOMAIN" --email "$ACME_EMAIL" --agree-tos \
        --non-interactive --no-eff-email --keep-until-expiring --deploy-hook "systemctl reload nginx" \
        ${NODESERVICE_CERTBOT_ARGS:-} 2>&1); then
        printf '%s\n' "$out" >>"$LOG"
        STEP_SHORT="не выдан"
        STEP_FAIL="Сертификат не получен: $(certbot_reason "$out"). Сайт панели в nginx остался без https — запустите установку снова, когда исправите причину: собирать панель заново не придётся."
        return 1
    fi
    printf '%s\n' "$out" >>"$LOG"
    OWN_CRT="/etc/letsencrypt/live/$PANEL_DOMAIN/fullchain.pem"
    OWN_KEY="/etc/letsencrypt/live/$PANEL_DOMAIN/privkey.pem"
    end=$(openssl x509 -noout -enddate -in "$OWN_CRT" 2>/dev/null | cut -d= -f2)
    STEP_RESULT="до $(ru_date "$end" short), продление само"
}

step_nginx_https() {
    local conf t
    conf=$(nginx_conf "$PANEL_DOMAIN" "$(panel_upstream)" https "$NGINX_V6" "$NGINX_H2" "$OWN_CRT" "$OWN_KEY" "$NGINX_ADDR")
    cp -p "$NGINX_FILE" "$NGINX_FILE.nodeservice.bak"
    printf '%s\n' "$conf" >"$NGINX_FILE"
    if ! t=$(nginx -t 2>&1); then
        printf '%s\n' "$t" >>"$LOG"
        mv -f "$NGINX_FILE.nodeservice.bak" "$NGINX_FILE"
        nginx_reload >>"$LOG" 2>&1 || true
        STEP_SHORT="не принят"
        STEP_FAIL="nginx не принял https для сайта панели — вернул прежние настройки. $(nginx_error_line "$t")"
        return 1
    fi
    rm -f "$NGINX_FILE.nodeservice.bak"
    nginx_reload >>"$LOG" 2>&1 || { STEP_SHORT="не перезагрузился"; STEP_FAIL="nginx не перезагрузился."; return 1; }
    STEP_RESULT="включён"
}

step_caddy_site() {
    local file baseline=0 out
    file=$(env_get PANEL_PROXY_FILE)
    cp -p "$CADDYFILE" "$CADDYFILE.nodeservice.bak"
    caddy validate --config "$CADDYFILE" --adapter caddyfile >>"$LOG" 2>&1 && baseline=1
    caddy_site_block "$PANEL_DOMAIN" "$(panel_upstream)" >"$file"
    caddy_import_set "$CADDYFILE" "$file"
    if (( baseline )) && ! out=$(caddy validate --config "$CADDYFILE" --adapter caddyfile 2>&1); then
        printf '%s\n' "$out" >>"$LOG"
        cat "$CADDYFILE.nodeservice.bak" >"$CADDYFILE"
        rm -f "$file"
        STEP_SHORT="не принят"
        STEP_FAIL="Caddy не принял сайт панели — вернул прежние настройки, ваши сайты работают как раньше."
        return 1
    fi
    if ! systemctl reload caddy >>"$LOG" 2>&1; then
        cat "$CADDYFILE.nodeservice.bak" >"$CADDYFILE"
        rm -f "$file"
        systemctl reload caddy >>"$LOG" 2>&1 || true
        STEP_SHORT="не принят"
        STEP_FAIL="Caddy не перезагрузился с сайтом панели — вернул прежние настройки, ваши сайты работают как раньше."
        return 1
    fi
    STEP_RESULT="настройки приняты"
}

step_docker_link() {
    local up
    up=$(panel_upstream)
    if docker exec "$DC_NAME" sh -c "command -v wget" >/dev/null 2>&1; then
        if ! docker exec "$DC_NAME" wget -q -T 5 -O- "http://$up/api/health/live" >>"$LOG" 2>&1; then
            STEP_SHORT="нет связи"
            STEP_FAIL="Caddy из контейнера $DC_NAME не достучался до панели ($up)."
            return 1
        fi
    fi
    if [[ -n $DC_NET ]]; then STEP_RESULT="сеть $DC_NET"; else STEP_RESULT="порт $up"; fi
}

step_docker_site() {
    local inner=${DC_INNER:-/etc/caddy/Caddyfile} out
    cp -p "$DC_FILE" "$DC_FILE.nodeservice.bak"
    marker_block_set "$DC_FILE" "$(caddy_site_block "$PANEL_DOMAIN" "$(panel_upstream)")"
    if ! out=$(docker exec "$DC_NAME" caddy validate --config "$inner" --adapter caddyfile 2>&1); then
        printf '%s\n' "$out" >>"$LOG"
        cat "$DC_FILE.nodeservice.bak" >"$DC_FILE"
        STEP_SHORT="не принят"
        STEP_FAIL="Caddy в контейнере $DC_NAME не принял сайт панели — вернул прежние настройки, сайты работают как раньше."
        return 1
    fi
    if ! out=$(docker exec "$DC_NAME" caddy reload --config "$inner" --adapter caddyfile 2>&1); then
        printf '%s\n' "$out" >>"$LOG"
        cat "$DC_FILE.nodeservice.bak" >"$DC_FILE"
        docker exec "$DC_NAME" caddy reload --config "$inner" --adapter caddyfile >>"$LOG" 2>&1 || true
        STEP_SHORT="не перезагрузился"
        STEP_FAIL="Caddy в контейнере $DC_NAME не перезагрузился с сайтом панели — вернул прежние настройки."
        return 1
    fi
    STEP_RESULT="настройки приняты"
}

# Сертификат выпускает Caddy (свой или ваш) — ждём, пока сервер начнёт отдавать настоящий сертификат.
CERT_END=""
step_cert_wait() {
    # Домен указывает не сюда — публичный сертификат не выпустится, долго ждать незачем.
    local tries=${NODESERVICE_CERT_TRIES:-30}
    (( DNS_OK )) || tries=${NODESERVICE_CERT_TRIES:-3}
    if verify_panel "$PANEL_DOMAIN" "$PANEL_HTTPS_PORT" "$tries" || [[ $VERIFY_STATE != tls && $VERIFY_STATE != timeout && $VERIFY_STATE != refused ]]; then
        CERT_END=$(tls_enddate "$PANEL_DOMAIN" "$PANEL_HTTPS_PORT" || true)
        if [[ $MODE == caddy || $MODE == caddy-docker ]]; then
            STEP_RESULT="Caddy выпустил${CERT_END:+, до $(ru_date "$CERT_END" short)}"
        else
            STEP_RESULT="${CERT_END:+до $(ru_date "$CERT_END" short)}"
        fi
        STEP_RESULT=${STEP_RESULT:-есть}
        return 0
    fi
    STEP_SHORT="ещё не выпущен"
    STEP_WARN=cert
    return 2
}

step_verify() {
    if [[ $MODE == internal ]]; then
        if verify_internal "$PANEL_URL" "${NODESERVICE_VERIFY_TRIES:-6}"; then
            STEP_RESULT="открывается"
            return 0
        fi
        case $VERIFY_STATE in
            refused) STEP_SHORT="никто не отвечает"; STEP_FAIL="По адресу $PANEL_URL никто не отвечает — панель не запустилась." ;;
            http) STEP_SHORT="отвечает не панель"; STEP_FAIL="По адресу $PANEL_URL отвечает не панель ($VERIFY_DETAIL)." ;;
            *) STEP_SHORT="не открывается"; STEP_FAIL="$PANEL_URL не открывается: ${VERIFY_DETAIL:-нет ответа}." ;;
        esac
        return 1
    fi
    if verify_panel "$PANEL_DOMAIN" "$PANEL_HTTPS_PORT" "${NODESERVICE_VERIFY_TRIES:-6}"; then
        STEP_RESULT="открывается"
        [[ -n $CERT_END ]] || CERT_END=$(tls_enddate "$PANEL_DOMAIN" "$PANEL_HTTPS_PORT" || true)
        return 0
    fi
    case $VERIFY_STATE in
        tls) STEP_SHORT="ждёт сертификат"; STEP_WARN=cert; return 2 ;;
        refused) STEP_SHORT="никто не отвечает"; STEP_FAIL="По адресу $PANEL_URL никто не отвечает на этом сервере." ;;
        http) STEP_SHORT="отвечает не панель"; STEP_FAIL="По адресу $PANEL_URL отвечает не панель ($VERIFY_DETAIL) — веб-сервер не достучался до неё." ;;
        *) STEP_SHORT="не открывается"; STEP_FAIL="$PANEL_URL не открывается: ${VERIFY_DETAIL:-нет ответа}." ;;
    esac
    return 1
}

step_restore() {
    bash "$APP_DIR/infra/scripts/restore.sh" "$RESTORE_FILE" --yes >>"$LOG" 2>&1 ||
        { STEP_SHORT="не удалось"; STEP_FAIL="Восстановление не удалось — панель запущена с пустой базой. Подробности — в журнале."; return 1; }
    STEP_RESULT="данные из копии"
}

# Доступ к коду: публичный репозиторий — по HTTPS; приватный — по deploy-ключу (единственное, что нужно сделать
# руками, и только для закрытого репозитория). Это до шагов: здесь надо дождаться вас.
CLONE_URL=$REPO_HTTPS
if [[ ! -d "$APP_DIR/.git" ]] && ! git ls-remote --quiet "$REPO_HTTPS" >/dev/null 2>&1; then
    command -v git >/dev/null || { apt-get update -qq >>"$LOG" 2>&1; apt-get install -y -qq git >>"$LOG" 2>&1; }
    if ! git ls-remote --quiet "$REPO_HTTPS" >/dev/null 2>&1; then
        mkdir -p -m 700 /root/.ssh
        [[ -f "$DEPLOY_KEY" ]] || ssh-keygen -t ed25519 -N '' -C "nodeservice-deploy@$(hostname)" -f "$DEPLOY_KEY" >/dev/null
        warn "Репозиторий закрытый. Добавьте этот публичный ключ как Deploy key (только чтение):"
        say "   ${C}https://github.com/feauche/nodeservice-panel/settings/keys/new${N}"
        echo
        cat "${DEPLOY_KEY}.pub"
        echo
        read -rp "Добавили ключ — нажмите Enter, чтобы продолжить... " _ </dev/tty
        ssh-keyscan -t ed25519 github.com >>/root/.ssh/known_hosts 2>/dev/null || true
        export GIT_SSH_COMMAND="ssh -i $DEPLOY_KEY -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new"
        CLONE_URL=$REPO_SSH
        echo
    fi
fi

NGINX_ADDR="" NGINX_V6=0 NGINX_H2=old
CERT_PENDING=0
for s in "${STEPS[@]}"; do
    label=${s%%|*}
    fn=${s#*|}
    rc=0
    run_step "$label" "$fn" || rc=$?
    case $rc in
        0) ;;
        2) [[ $STEP_WARN == cert ]] && CERT_PENDING=1 ;;
        *) fail_step ;;
    esac
done
echo

# --- Итог ---

TOKEN="" SETUP_URL=""
if [[ -z $RESTORE_FILE ]]; then
    set +e
    cli_out=$("${COMPOSE[@]}" exec -T api node dist/cli.js setup-token 2>&1)
    cli_rc=$?
    set -e
    if (( cli_rc == 0 )); then
        TOKEN=$(sed -n 's/^[[:space:]]\{4\}\([^[:space:]]\{1,\}\)$/\1/p' <<<"$cli_out" | head -n 1)
        SETUP_URL=$(sed -n 's/^Открой \([^ ]*\) .*/\1/p' <<<"$cli_out" | head -n 1)
    fi
fi

if (( CERT_PENDING )); then
    say "${Y}! Панель работает, но сертификата пока нет.${N}"
    if (( ! DNS_OK )); then
        if [[ -z $RESOLVED ]]; then
            say "Домен $PANEL_DOMAIN не найден в DNS. Добавьте A-запись на ${PUBLIC_IP:-адрес этого сервера} у регистратора домена — сертификат выпустится сам в течение нескольких минут." 2
        else
            say "Домен $PANEL_DOMAIN указывает на $RESOLVED, а у этого сервера адрес ${PUBLIC_IP:-другой}. Исправьте A-запись у регистратора домена — сертификат выпустится сам в течение нескольких минут." 2
        fi
    else
        say "Сертификат выпускается дольше обычного. Обычно это занимает до пары минут; проверить позже: nodeservice status." 2
    fi
    say "Запускать установку заново не нужно." 2
elif [[ $MODE == internal ]]; then
    say "${G}✓ Готово.${N} Панель открывается во внутренней сети: ${A}$PANEL_URL${N}"
    say "Снаружи — через VPN в эту сеть или проброс порта по SSH, например:" 2
    say "${B}ssh -L 8080:$INTERNAL_ADDR:$INTERNAL_PORT root@сервер-с-доступом-в-сеть${N}" 4
    say "и откройте http://localhost:8080 (в Termius — то же пробросом порта)." 2
else
    say "${G}✓ Готово.${N} Панель открывается: ${A}$PANEL_URL${N}"
    [[ -n $CERT_END ]] && say "Сертификат до $(ru_date "$CERT_END"), продление — само." 2
fi
echo
if [[ -n $RESTORE_FILE ]]; then
    say "Данные восстановлены — вход прежним паролем и кодом из приложения." 2
    [[ $MODE == internal ]] ||
        say "Если домен переехал, переключите A-запись $PANEL_DOMAIN на этот сервер — сертификат выпустится сам." 2
elif [[ -n $TOKEN ]]; then
    say "Токен первого запуска (одноразовый):" 2
    say "${B}$TOKEN${N}" 2
    say "Откройте ${SETUP_URL:-$PANEL_URL/setup}, вставьте токен и задайте пароль." 2
elif grep -q "уже создан" <<<"${cli_out:-}"; then
    say "Администратор уже есть — вход прежним паролем и кодом из приложения. Сброс пароля: nodeservice cli reset-password" 2
else
    say "${Y}Не удалось выпустить токен первого запуска.${N} Повторите позже: nodeservice cli setup-token" 2
fi
echo
say "${D}Команды: nodeservice status · logs · update · backup · restore · uninstall${N}"
log "=== установка завершена: $MODE $PANEL_URL"
