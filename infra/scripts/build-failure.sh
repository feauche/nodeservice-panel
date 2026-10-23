# shellcheck shell=bash
# Почему не собрался образ панели — по выводу сборки (docker compose build). Общее для install.sh и update.sh:
# вид причины и строка-доказательство отсюда, «что делать» у каждого скрипта своё.
# Использование: . build-failure.sh; kind=$(build_failure_kind файл); line=$(build_failure_line файл "$kind").
# Файл — вывод сборки; годится и <(tail …): если кончилось место, копию на диск не записать.

# Признаки по видам.
# Память: Node упёрся в свой предел (heap out of memory, код 134) или ядро убило процесс (Killed, код 137).
BUILD_FAIL_MEMORY='heap out of memory|Reached heap limit|exit code: 13[47]([^0-9]|$)|(^|[[:space:]])Killed([[:space:]]|$)|signal: killed|Cannot allocate memory|ENOMEM'
BUILD_FAIL_DISK='no space left on device|ENOSPC'
# Сеть: не скачались образ Node с Docker Hub или пакеты npm, либо Docker Hub ограничил скачивание.
BUILD_FAIL_NETWORK='EAI_AGAIN|ENOTFOUND|ETIMEDOUT|ECONNRESET|ECONNREFUSED|ERR_PNPM_META_FETCH_FAIL|ERR_PNPM_FETCH_|Temporary failure (resolving|in name resolution)|Could not resolve host|TLS handshake timeout|i/o timeout|toomanyrequests|failed to resolve source metadata|network is unreachable'
BUILD_FAIL_TAIL=80

# Что разбирать: строки упавшего шага и итог сборки. У BuildKit строка шага начинается с «#N », упавший шаг
# пишет «#N ERROR:». Параллельный шаг (apt-get образа запуска) вставляет свои строки и после падения — их
# отбрасываем, как и прошлые шаги (там бывают повторы скачивания, которые сборке не помешали). Строки без «#»
# — итог: блок с концом вывода шага и «failed to solve». Нет «#N ERROR:» (упала до шагов, например не скачался
# образ Node) — последние BUILD_FAIL_TAIL строк.
build_failure_text() {
    local text step
    text=$(cat "$1" 2>/dev/null || true)
    step=$(grep -oE '^#[0-9]+ ERROR:' <<<"$text" | tail -n 1 | tr -dc '0-9' || true)
    if [[ -n $step ]]; then
        grep -E "^#$step |^[^#]" <<<"$text" || true
    else
        tail -n "$BUILD_FAIL_TAIL" <<<"$text"
    fi
}

# memory | disk | network | other
build_failure_kind() {
    local text
    text=$(build_failure_text "$1")
    if grep -qE "$BUILD_FAIL_MEMORY" <<<"$text"; then
        printf 'memory\n'
    elif grep -qiE "$BUILD_FAIL_DISK" <<<"$text"; then
        printf 'disk\n'
    elif grep -qiE "$BUILD_FAIL_NETWORK" <<<"$text"; then
        printf 'network\n'
    else
        printf 'other\n'
    fi
}

# Строка вывода, по которой видна причина, без номера шага и времени сборки («#17 8.393 »). Пусто, если такой нет.
build_failure_line() {
    local pattern flags=-iE
    case $2 in
        # Код выхода 134 или 137 человеку ничего не говорит — показываем строку Node или ядра.
        memory) pattern='heap out of memory|Reached heap limit|Cannot allocate memory|ENOMEM|(^|[[:space:]])Killed([[:space:]]|$)|signal: killed' flags=-E ;;
        disk) pattern=$BUILD_FAIL_DISK ;;
        network) pattern=$BUILD_FAIL_NETWORK ;;
        *) return 0 ;;
    esac
    build_failure_text "$1" | grep "$flags" "$pattern" | tail -n 1 |
        sed -E 's/^(#[0-9]+ )?[0-9]+\.[0-9]+ +//; s/^[[:space:]]+//' | cut -c1-200 || true
}

# «0,9 ГБ памяти и 2 ГБ подкачки» — сколько сейчас у сервера.
build_memory_text() {
    awk 'function g(k,  v) { v = sprintf("%.1f", k / 1048576); sub(/\.0$/, "", v); sub(/\./, ",", v); return v }
        /^MemTotal:/ { m = $2 } /^SwapTotal:/ { s = $2 }
        END { printf "%s ГБ памяти и %s ГБ подкачки\n", g(m), g(s) }' "${BUILD_MEMINFO:-/proc/meminfo}"
}

# Память и подкачка вместе, МБ.
BUILD_ENOUGH_MEMORY_MB=4096
build_memory_total_mb() {
    awk '/^(MemTotal|SwapTotal):/ { t += $2 } END { print int(t / 1024) }' "${BUILD_MEMINFO:-/proc/meminfo}"
}

# Чья нехватка памяти (вид memory), чтобы не советовать ложного:
#   short — мало у сервера (памяти и подкачки вместе меньше 4 ГБ): добавить памяти;
#   limit — у сервера с запасом, а Node упёрся в свой предел сборки (NODE_OPTIONS в apps/api/Dockerfile,
#           код 134): ошибка панели;
#   cage  — у сервера видно с запасом, но процесс убило ядро (Killed, код 137): у машины или контейнера свой
#           предел памяти меньше видимого (например, контейнер LXC в Proxmox) — увеличить его.
build_memory_verdict() {
    local text
    if (( $(build_memory_total_mb) < BUILD_ENOUGH_MEMORY_MB )); then
        printf 'short\n'
        return 0
    fi
    text=$(build_failure_text "$1")
    if grep -qE 'heap out of memory|Reached heap limit|exit code: 134([^0-9]|$)' <<<"$text"; then
        printf 'limit\n'
    else
        printf 'cage\n'
    fi
}

# Места почти не осталось (меньше 2 ГБ там, где Docker хранит образы). Сборка могла упасть из-за этого, даже
# если в её выводе не видно: на полный диск журнал не дописывается. Проверять, когда вид вышел other.
build_disk_low() {
    local dir avail
    dir=$(docker info -f '{{.DockerRootDir}}' 2>/dev/null || true)
    [[ -n $dir && -d $dir ]] || dir=/
    avail=$(df -BG --output=avail "$dir" 2>/dev/null | tail -n 1 | tr -dc '0-9' || true)
    [[ $avail =~ ^[0-9]+$ ]] && (( avail < 2 ))
}
