import { SERVER_CHECK_OUTPUT_MAX, type ServerCheckKey } from '@nodeservice/shared';

/**
 * Команды реестра проверок (R5/J9). Выполняются по SSH от root через bash (нужна подстановка `<(…)`).
 * Чужие скрипты берутся только по https — те же, что вызывает multitest, но без него самого: сам multitest
 * лишь обёртка с меню, и тянуть её значит доверять ещё одному источнику, который может поменяться.
 * Маркер `# ns-check:<ключ>` в первой строке — по нему тестовый sshd и логи узнают команду.
 * Каждая команда обёрнута в серверный `timeout`, чуть меньший панельного, чтобы скрипт завершился сам.
 */

/** Серверные таймауты (секунды). */
const SERVER_TIMEOUT_SEC: Record<ServerCheckKey, number> = {
  cpu: 120,
  ip_region: 240,
  geoblock: 300,
  dpi: 300,
  ip_quality: 480,
  iperf3_ru: 900,
  yabs: 1800,
};

/** Панельные таймауты (мс): на минуту больше серверных — плюс установка недостающих пакетов. */
export const SERVER_CHECK_TIMEOUT_MS: Record<ServerCheckKey, number> = Object.fromEntries(
  Object.entries(SERVER_TIMEOUT_SEC).map(([k, sec]) => [k, (sec + 5 * 60) * 1000]),
) as Record<ServerCheckKey, number>;

const ENV = 'export DEBIAN_FRONTEND=noninteractive LC_ALL=C.UTF-8 LANG=C.UTF-8 TERM=dumb NO_COLOR=1';

/**
 * need <команда> <пакет> [запасной пакет…]: ставит недостающее через apt (Debian/Ubuntu), ждёт чужую
 * блокировку apt. Пакеты-кандидаты — потому что имя меняется между версиями (column: bsdextrautils на
 * новых, util-linux на старых). Не получилось — понятная строка и выход с кодом 3.
 */
const NEED = [
  'need() {',
  '  cmd="$1"; shift',
  '  command -v "$cmd" >/dev/null 2>&1 && return 0',
  '  if command -v apt-get >/dev/null 2>&1; then',
  '    echo "Устанавливаю недостающую программу: $cmd"',
  '    updated=""',
  '    for pkg in "$@"; do',
  '      timeout 240 apt-get -o DPkg::Lock::Timeout=180 install -y -qq "$pkg" >/dev/null 2>&1 && break',
  '      if [ -z "$updated" ]; then',
  '        updated=1',
  '        timeout 240 apt-get -o DPkg::Lock::Timeout=180 update -qq >/dev/null 2>&1',
  '        timeout 240 apt-get -o DPkg::Lock::Timeout=180 install -y -qq "$pkg" >/dev/null 2>&1 && break',
  '      fi',
  '    done',
  '  fi',
  '  command -v "$cmd" >/dev/null 2>&1 || { echo "Не удалось установить $cmd — проверка невозможна."; exit 3; }',
  '}',
].join('\n');

/** Запуск чужого скрипта по https без ввода с клавиатуры (любой вопрос скрипта получит пустой ответ). */
const remote = (key: ServerCheckKey, url: string, args = '') =>
  `timeout -k 20 ${SERVER_TIMEOUT_SEC[key]} bash <(curl -fsSL --proto '=https' --max-time 60 ${url})${args ? ` ${args}` : ''} </dev/null`;

const BODY: Record<ServerCheckKey, string[]> = {
  cpu: [
    'need sysbench sysbench',
    'echo "== Одно ядро"',
    `timeout -k 10 ${SERVER_TIMEOUT_SEC.cpu / 2} sysbench cpu --threads=1 --time=10 run`,
    'echo "== Все ядра: $(nproc)"',
    `timeout -k 10 ${SERVER_TIMEOUT_SEC.cpu / 2} sysbench cpu --threads="$(nproc)" --time=10 run`,
  ],
  ip_region: [
    'need jq jq',
    'need column bsdextrautils util-linux',
    remote('ip_region', 'https://raw.githubusercontent.com/Davoyan/ipregion/main/ipregion.sh'),
  ],
  // censorcheck сам проверяет curl, dig, jq и column и без них выходит с «Missing dependencies».
  geoblock: [
    'need dig dnsutils bind9-dnsutils',
    'need jq jq',
    'need column bsdextrautils util-linux',
    remote(
      'geoblock',
      'https://raw.githubusercontent.com/vernette/censorcheck/master/censorcheck.sh',
      '--mode geoblock',
    ),
  ],
  dpi: [
    'need dig dnsutils bind9-dnsutils',
    'need jq jq',
    'need column bsdextrautils util-linux',
    remote(
      'dpi',
      'https://raw.githubusercontent.com/vernette/censorcheck/master/censorcheck.sh',
      '--mode dpi',
    ),
  ],
  // -E: английский и полный прогон без меню; -n: не ставить зависимости молча.
  ip_quality: [remote('ip_quality', 'https://IP.Check.Place', '-E -n')],
  iperf3_ru: [
    'need iperf3 iperf3',
    'need jq jq',
    'need ping iputils-ping',
    remote(
      'iperf3_ru',
      'https://raw.githubusercontent.com/itdoginfo/russian-iperf3-servers/main/speedtest.sh',
    ),
  ],
  // -4: только IPv4 (у многих серверов нет IPv6, иначе сетевой замер тратит время на таймауты).
  yabs: [remote('yabs', 'https://yabs.sh', '-4')],
};

/** Одинарные кавычки для `bash -c` — тот же приём, что и SH() у действий. */
const q = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;

export function checkCommand(key: ServerCheckKey): string {
  const body = [`# ns-check:${key}`, ENV, 'need curl curl', ...BODY[key]].join('\n');
  // NEED объявляется раньше первого вызова; маркер остаётся первой строкой самой команды.
  return `# ns-check:${key}\nbash -c ${q([NEED, body].join('\n'))}`;
}

/** Цветовые и управляющие последовательности терминала — в хранимом выводе они только мусор. */
const ANSI_RE =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: это и есть управляющие символы, которые вырезаем
  /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007]*(?:\u0007|\u001b\\)|\u001b[()][A-Za-z0-9]|\u001b[=>]/g;

/**
 * Привести вывод к читаемому тексту: без цветов, а строки с «прогресс-баром» через \r — только последним
 * состоянием (иначе от одного индикатора остаются сотни копий).
 */
export function cleanOutput(raw: string): string {
  return (
    raw
      .replace(ANSI_RE, '')
      .split('\n')
      .map((line) => {
        const parts = line.split('\r').filter((p) => p.length > 0);
        return parts.length > 0 ? (parts.at(-1) as string) : '';
      })
      .join('\n')
      // biome-ignore lint/suspicious/noControlCharactersInRegex: прочие непечатаемые символы
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
      .replace(/\n{3,}/g, '\n\n')
  );
}

/** Длинный вывод: начало и конец важнее середины (шапка скрипта и итоговая таблица). */
export function capOutput(text: string, max = SERVER_CHECK_OUTPUT_MAX): string {
  if (text.length <= max) return text;
  const head = Math.floor(max / 3);
  const tail = max - head;
  return `${text.slice(0, head)}\n\n… вывод сокращён, пропущено ${text.length - max} символов …\n\n${text.slice(-tail)}`;
}

/**
 * Признак полного отчёта: некоторые скрипты выходят с ненулевым кодом и при успехе. IPQuality последней
 * строкой проверяет IPv6 через `[[ … ]] && …` — без IPv6 на сервере весь скрипт завершается кодом 1,
 * хотя отчёт напечатан целиком.
 */
const COMPLETE_RE: Partial<Record<ServerCheckKey, RegExp>> = {
  ip_quality: /IP QUALITY CHECK REPORT[\s\S]*\n={20,}/,
};

/** Скрипт напечатал полный отчёт — считаем проверку успешной независимо от кода выхода. */
export function reportComplete(key: ServerCheckKey, text: string): boolean {
  return COMPLETE_RE[key]?.test(text) ?? false;
}

/**
 * Убрать из вывода то, что к проверке не относится. IPQuality перед отчётом печатает рекламные баннеры
 * спонсоров (прокси, хостинги) — отчёт начинается с первой строки из «#».
 */
export function stripNoise(key: ServerCheckKey, text: string): string {
  if (key !== 'ip_quality') return text;
  const at = text.search(/^#{20,}\s*$/m);
  return at > 0 ? text.slice(at) : text;
}

/** Понятная причина по коду выхода. */
export function exitReason(code: number): string {
  if (code === 124 || code === 137) return 'Проверка не уложилась в отведённое время и была остановлена.';
  if (code === 3) return 'Не удалось установить нужный пакет — смотрите вывод.';
  return `Скрипт проверки завершился с ошибкой (код ${code}). Причина — в выводе.`;
}
