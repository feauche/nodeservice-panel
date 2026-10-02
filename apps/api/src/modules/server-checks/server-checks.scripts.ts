import { SERVER_CHECK_OUTPUT_MAX, type ServerCheckKey } from '@nodeservice/shared';

type ScriptCheckKey = Exclude<ServerCheckKey, 'russia_access'>;

/**
 * Команды реестра проверок (R5/J9). Выполняются по SSH от root через bash.
 * Чужие скрипты берутся только по https — те же, что вызывает multitest, но без него самого: сам multitest
 * лишь обёртка с меню, и тянуть её значит доверять ещё одному источнику, который может поменяться.
 * Маркер `# ns-check:<ключ>` в первой строке — по нему тестовый sshd и логи узнают команду.
 * Каждая команда обёрнута в серверный `timeout`, чуть меньший панельного, чтобы скрипт завершился сам.
 */

/** Серверные таймауты (секунды). */
const SERVER_TIMEOUT_SEC: Record<ScriptCheckKey, number> = {
  cpu: 120,
  ip_region: 240,
  geoblock: 300,
  dpi: 300,
  ip_quality: 480,
  iperf3_ru: 900,
  yabs: 1800,
};

/** Панельные таймауты (мс): на минуту больше серверных — плюс установка недостающих пакетов. */
export const SERVER_CHECK_TIMEOUT_MS: Record<ScriptCheckKey, number> = Object.fromEntries(
  Object.entries(SERVER_TIMEOUT_SEC).map(([k, sec]) => [k, (sec + 5 * 60) * 1000]),
) as Record<ScriptCheckKey, number>;

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

/** Закреплённая версия стороннего скрипта: raw-адрес с коммитом и sha256 самого файла. */
export interface ScriptPin {
  url: string;
  sha256: string;
  /**
   * Скрипт во время работы сам качает свои файлы из ветки автора: в скачанном файле `from` меняется на
   * `to` (тот же коммит, что в url), и запускается только переписанный файл с суммой `sha256`.
   */
  refs?: { from: string; to: string; sha256: string };
}

/**
 * Сторонние скрипты — только проверенная версия. Адрес с коммитом, а не с веткой: новая версия у автора
 * (или взломанный репозиторий) сама на серверы не попадёт. Сумму сверяем ещё и на сервере — подменённый
 * по дороге файл не запустится. IP.Check.Place и yabs.sh — лишь переадресации на main/master этих же
 * репозиториев, поэтому качаем сразу закреплённый файл из GitHub.
 * Обновить версию: прочитать изменения в новом коммите, скачать файл, `sha256sum`, заменить обе строки. Если
 * скрипт сам докачивает что-то из ветки (`grep -n 'main/\|master/'`), — ещё refs и сумма переписанного файла:
 * `curl -fsSL <адрес> | sed 's|<from>|<to>|g' | sha256sum`.
 * Версии и суммы сняты 01.10.2026 — файлы совпадали с тем, что тогда отдавали ветки и адреса.
 */
export const SCRIPT_PINS = {
  ipregion: {
    url: 'https://raw.githubusercontent.com/Davoyan/ipregion/a85abbf739e07b1162bee066d756be1e4b9bfcc0/ipregion.sh',
    sha256: '17eb73e776f7ab292e30f12223a78c8f25a0ed6808e8204434d122f06e4b4b0e',
  },
  censorcheck: {
    url: 'https://raw.githubusercontent.com/vernette/censorcheck/42a688b855b37bc6e97eace1897df38897b8d9fe/censorcheck.sh',
    sha256: 'e8e2d3a364d1e92087e1571f8bf5bad529884c79375c9002916f40be5855b9b8',
  },
  ipquality: {
    url: 'https://raw.githubusercontent.com/xykt/IPQuality/2384a67c756eb35231f5982b34731e522be3653e/ip.sh',
    sha256: 'b30df5a3c2204276c54e99dcc5080b46f8a627667730aee7de63b109b8ecaecf',
    // Список DNSBL (его строки скрипт подставляет в команды bash), куки, справочник стран и рекламу ip.sh
    // качает из ветки main («${rawgithub}main/ref/…»): берём их из того же коммита.
    refs: {
      from: '}main/',
      to: '}2384a67c756eb35231f5982b34731e522be3653e/',
      sha256: '1b9c0476559741323337a3c13c8e59986df34eb1d30e3b7021fcb29d027709cc',
    },
  },
  iperf3ru: {
    url: 'https://raw.githubusercontent.com/itdoginfo/russian-iperf3-servers/87abe95057f5e43f96640b22ea145c12be38a867/speedtest.sh',
    sha256: '068d37703beab0ec7e44a24ed45f6e911af51511ea6476a85add7250fab3d3dc',
  },
  yabs: {
    url: 'https://raw.githubusercontent.com/masonr/yet-another-bench-script/ad1af039ce5d6e0091a35f87f1fa71ae2d411bf2/yabs.sh',
    sha256: '54d23e3b17d36d1f4e40895c6a9929601e664ff1cf1a9217b034a60076ac504f',
  },
} satisfies Record<string, ScriptPin>;
export type ScriptPins = Record<keyof typeof SCRIPT_PINS, ScriptPin>;

/**
 * Коды выхода обёртки: скрипт не скачался / скачанный не совпал с закреплённым (тогда он не запускается) /
 * переписанный под закреплённые файлы не совпал с проверенным (сбой на сервере, скрипт тоже не запускается).
 * Сами закреплённые скрипты выходят с 0–11, 40, 60 и 130, curl — до 99, timeout — 124–137.
 */
export const SCRIPT_FETCH_FAILED_EXIT = 111;
export const SCRIPT_CHANGED_EXIT = 112;
export const SCRIPT_PREPARE_FAILED_EXIT = 113;

/**
 * Запуск чужого скрипта без ввода с клавиатуры (любой вопрос скрипта получит пустой ответ): скачать во
 * временный файл, сверить sha256 с закреплённой, только тогда запустить. Качает скрипт что-то своё из ветки
 * автора — сначала переписать эти адреса на закреплённый коммит и сверить уже переписанный файл. Файлы
 * удаляются при выходе.
 */
const remote = (key: ScriptCheckKey, pin: ScriptPin, args = '') =>
  [
    'f=$(mktemp) || exit 1',
    `trap 'rm -f "$f" "$f.pin"' EXIT`,
    `curl -fsSL --proto '=https' --max-time 60 -o "$f" ${pin.url} || { echo "Не удалось скачать скрипт проверки."; exit ${SCRIPT_FETCH_FAILED_EXIT}; }`,
    'sum=$(sha256sum < "$f")',
    `[ "\${sum%% *}" = "${pin.sha256}" ] || { echo "Скачанный скрипт не совпал с проверенной версией — запуск отменён."; exit ${SCRIPT_CHANGED_EXIT}; }`,
    ...(pin.refs
      ? [
          `sed 's|${pin.refs.from}|${pin.refs.to}|g' "$f" > "$f.pin"`,
          'sum=$(sha256sum < "$f.pin")',
          `[ "\${sum%% *}" = "${pin.refs.sha256}" ] || { echo "Не удалось подготовить скрипт проверки к запуску."; exit ${SCRIPT_PREPARE_FAILED_EXIT}; }`,
        ]
      : []),
    `timeout -k 20 ${SERVER_TIMEOUT_SEC[key]} bash ${pin.refs ? '"$f.pin"' : '"$f"'}${args ? ` ${args}` : ''} </dev/null`,
  ].join('\n');

/** Сумму считает sha256sum (coreutils): без него сверить нельзя — честный отказ need, а не «не совпал». */
const NEED_SUM = 'need sha256sum coreutils';

const body = (pins: ScriptPins): Record<ScriptCheckKey, string[]> => ({
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
    NEED_SUM,
    remote('ip_region', pins.ipregion),
  ],
  // censorcheck сам проверяет curl, dig, jq и column и без них выходит с «Missing dependencies».
  geoblock: [
    'need dig dnsutils bind9-dnsutils',
    'need jq jq',
    'need column bsdextrautils util-linux',
    NEED_SUM,
    remote('geoblock', pins.censorcheck, '--mode geoblock'),
  ],
  dpi: [
    'need dig dnsutils bind9-dnsutils',
    'need jq jq',
    'need column bsdextrautils util-linux',
    NEED_SUM,
    remote('dpi', pins.censorcheck, '--mode dpi'),
  ],
  // -E: английский и полный прогон без меню; -n: не ставить зависимости молча.
  ip_quality: [NEED_SUM, remote('ip_quality', pins.ipquality, '-E -n')],
  iperf3_ru: [
    'need iperf3 iperf3',
    'need jq jq',
    'need ping iputils-ping',
    NEED_SUM,
    remote('iperf3_ru', pins.iperf3ru),
  ],
  // fio и iperf3 — из пакетов системы: найдя их, YABS свои сборки не качает (без -b), а иначе брал бы
  // последний выпуск из релизов автора и запускал его от root без сверки.
  // -4 — Geekbench 4 вместо шестого (не «только IPv4»: IPv6 YABS проверяет сам): проходит и при 1 ГБ памяти,
  // где шестой может упасть; на ARM его нет. Баллы с шестым не сравнимы — правило у Джарвиса (check-explain).
  // Сам Geekbench скрипт качает с сайта Primate Labs без сверки — так и сказано у проверки.
  yabs: ['need fio fio', 'need iperf3 iperf3', NEED_SUM, remote('yabs', pins.yabs, '-4')],
});

/** Одинарные кавычки для `bash -c` — тот же приём, что и SH() у действий. */
const q = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;

/** pins — только для тестов (свой «скрипт» с известной суммой); на серверы идут SCRIPT_PINS. */
export function checkCommand(key: ScriptCheckKey, pins: ScriptPins = SCRIPT_PINS): string {
  const script = [`# ns-check:${key}`, ENV, 'need curl curl', ...body(pins)[key]].join('\n');
  // NEED объявляется раньше первого вызова; маркер остаётся первой строкой самой команды.
  return `# ns-check:${key}\nbash -c ${q([NEED, script].join('\n'))}`;
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

/** Итог запуска по коду выхода: скрипт, не совпавший с закреплённым, — отмена, а не ошибка. */
export function runStatus(code: number): 'failed' | 'cancelled' {
  return code === SCRIPT_CHANGED_EXIT ? 'cancelled' : 'failed';
}

/**
 * Понятная причина по коду выхода. Несовпавший скрипт — не «изменился у автора»: адрес закреплён по коммиту,
 * и новая версия у автора сюда не попадает. Такое бывает при подмене файла — это и сказано, как предположение.
 * До скачивания need мог поставить недостающие программы, поэтому «ничего не запускалось» не говорим.
 */
export function exitReason(code: number): string {
  if (code === 124 || code === 137) return 'Проверка не уложилась в отведённое время и была остановлена.';
  if (code === 3) return 'Не удалось установить нужный пакет — смотрите вывод.';
  if (code === SCRIPT_FETCH_FAILED_EXIT)
    return 'Не удалось скачать скрипт проверки — сам скрипт на сервере не запускался. Причина — в выводе.';
  if (code === SCRIPT_CHANGED_EXIT)
    return 'Скачанный скрипт не совпал с проверенной версией, записанной в панели, — запуск отменён, на сервере он не запускался. Файл могли подменить по дороге к серверу или на сайте, где он хранится.';
  if (code === SCRIPT_PREPARE_FAILED_EXIT)
    return 'Не удалось подготовить скрипт проверки к запуску — сам скрипт на сервере не запускался. Причина — в выводе.';
  return `Скрипт проверки завершился с ошибкой (код ${code}). Причина — в выводе.`;
}
