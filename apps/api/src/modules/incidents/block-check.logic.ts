import {
  BLOCK_1620_MAX_KB,
  BLOCK_1620_MIN_KB,
  BLOCK_1620_STEP_KB,
  BLOCK_1620_STEPS,
  BLOCK_CHECK_CONNECT_TIMEOUT_SEC,
  BLOCK_CHECK_READ_TIMEOUT_SEC,
  BLOCK_VERDICT_LABELS,
  type BlockCheckResult,
  type BlockProbeResult,
  type BlockVerdict,
  type Server,
} from '@nodeservice/shared';

import { SH } from './actions.registry.js';

/**
 * J10: проверка блокировки одной ноды (ТСПУ / «блок 16–20 КБ») с ДРУГОГО сервера парка. Три шага
 * подряд без валидных данных клиента VLESS (панель у Remnawave только читает, создавать пользователя
 * не может): TCP-порт → настоящее TLS-рукопожатие с нужным именем маскировки (SNI) → растущий объём
 * данных в отдельных TLS-сессиях с тем же именем. Reality заворачивает всё, что не опознал как своего
 * клиента, на реальный сайт маскировки — поэтому обычное TLS-подключение получает то же обращение со
 * стороны блокировщика, что и настоящий VPN-трафик, и отдельного клиента VLESS для проверки не нужно.
 */

/** Только серверы парка из России, с рабочим SSH, не сама проверяемая нода. */
export function pickRuProbes(
  excludeServerId: string | null,
  all: Pick<Server, 'id' | 'name' | 'sshOk' | 'country'>[],
  max = 3,
): Pick<Server, 'id' | 'name'>[] {
  return all
    .filter((s) => s.id !== excludeServerId && s.sshOk === true && s.country.code === 'RU')
    .sort((a, b) => a.name.localeCompare(b.name, 'ru'))
    .slice(0, max);
}

/** Зарубежные серверы парка с рабочим SSH (страна известна и не Россия), не сама проверяемая нода. */
export function pickForeignProbes(
  excludeServerId: string | null,
  all: Pick<Server, 'id' | 'name' | 'sshOk' | 'country'>[],
  max = 2,
): Pick<Server, 'id' | 'name'>[] {
  return all
    .filter(
      (s) =>
        s.id !== excludeServerId && s.sshOk === true && s.country.code !== null && s.country.code !== 'RU',
    )
    .sort((a, b) => a.name.localeCompare(b.name, 'ru'))
    .slice(0, max);
}

/**
 * Итог с учётом встречной проверки из-за рубежа: из России порт не отвечает ни с одного сервера, а из-за
 * рубежа отвечает хотя бы с одного — сервер жив, закрыт именно путь из России (блокировка IP).
 */
export function withForeign(ruVerdict: BlockVerdict, foreign: BlockProbeResult[]): BlockVerdict {
  if (ruVerdict !== 'unreachable') return ruVerdict;
  return foreign.some((p) => p.verdict === 'ok') ? 'ip_block' : 'unreachable';
}

/**
 * Адрес и имя маскировки приходят из Remnawave — панель эти данные не создаёт и не проверяет на
 * стороне Remnawave, а подставляет их в команду для ДРУГОГО сервера парка по SSH. Разрешаем только
 * форму, которой достаточно для IPv4, IPv6 и доменного имени; в этом наборе нет ни одного символа,
 * значимого для оболочки, — так испорченные или подставные данные не смогут вырваться из команды.
 */
const SAFE_HOST_RE = /^[A-Za-z0-9.:-]{1,253}$/;

function isSafePort(port: number): boolean {
  return Number.isInteger(port) && port > 0 && port < 65536;
}

/** true — адрес, порт и имя маскировки безопасно подставлять в команду проверки. */
export function isSafeBlockCheckTarget(address: string, port: number, sni: string | null): boolean {
  return SAFE_HOST_RE.test(address) && (sni === null || SAFE_HOST_RE.test(sni)) && isSafePort(port);
}

/** Одинарные кавычки для подстановки в оболочку — тот же приём, что и в SH(). */
const q = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;

/**
 * Команда для одного прогона на пробующем сервере — печатает ровно одну строку JSON в stdout.
 * `sni: null` — имя маскировки неизвестно: проверяем только, отвечает ли порт (stage "port"). Отличить
 * ТСПУ от живой ноды так нельзя, но «сервер совсем недоступен» (выключен, не оплачен) — можно.
 */
export function buildBlockCheckCommand(address: string, port: number, sni: string | null): string {
  // Проверка формы — обязательный барьер перед сборкой команды, а не только на вызывающей стороне.
  if (!isSafeBlockCheckTarget(address, port, sni))
    throw new Error('Проверка блокировки: подозрительные данные адреса, порта или имени маскировки.');
  const sizes: number[] = [];
  for (let i = 1; i <= BLOCK_1620_STEPS; i += 1) sizes.push(i * BLOCK_1620_STEP_KB);
  return SH(
    [
      '# ns-blockcheck',
      `addr=${q(address)}`,
      `port=${port}`,
      `sni=${q(sni ?? '')}`,
      // Шаг 1: обычный TCP-порт — если недоступен вообще, дальше проверять нечего.
      `if ! timeout ${BLOCK_CHECK_CONNECT_TIMEOUT_SEC} bash -c "exec 3<>/dev/tcp/\\$addr/\\$port" 2>/dev/null; then`,
      '  echo \'{"stage":"tcp","ok":false,"stalledAtKb":null}\'',
      '  exit 0',
      'fi',
      // Без имени маскировки глубже идти нечем: порт отвечает — это всё, что можно сказать честно.
      'if [ -z "$sni" ]; then',
      '  echo \'{"stage":"port","ok":true,"stalledAtKb":null}\'',
      '  exit 0',
      'fi',
      // Шаг 2: настоящее TLS-рукопожатие с именем маскировки ноды. Тихий обрыв без сертификата в
      // ответе (не отказ, а именно тишина) — признак блокировки по протоколу/имени, не сбоя сети.
      `tls_out=$(timeout ${BLOCK_CHECK_READ_TIMEOUT_SEC} openssl s_client -connect "$addr:$port" -servername "$sni" </dev/null 2>&1)`,
      'if ! printf \'%s\' "$tls_out" | grep -q "BEGIN CERTIFICATE"; then',
      '  echo \'{"stage":"tls","ok":false,"stalledAtKb":null}\'',
      '  exit 0',
      'fi',
      // Шаг 3: растущий объём данных (в заголовке запроса, не в теле — так гарантированно уходит по
      // сети до того, как сайт-маскировка вообще успеет ответить) в ОТДЕЛЬНЫХ соединениях по объёму —
      // так же надёжно проверяет порог «за сессию», не полагаясь на переиспользование TCP-соединения.
      'stalled=""',
      `for kb in ${sizes.join(' ')}; do`,
      "  pad=$(head -c $((kb*1000)) /dev/zero | tr '\\0' 'A')",
      `  curl -s -o /dev/null --max-time ${BLOCK_CHECK_READ_TIMEOUT_SEC} --connect-timeout ${BLOCK_CHECK_CONNECT_TIMEOUT_SEC} -H "X-Pad: $pad" "https://$sni:$port/" --resolve "$sni:$port:$addr" 2>/dev/null`,
      '  rc=$?',
      '  if [ "$rc" = "28" ]; then stalled=$kb; break; fi',
      '  if [ "$rc" != "0" ] && [ "$rc" != "22" ]; then stalled="err"; break; fi',
      'done',
      'if [ "$stalled" = "err" ]; then',
      '  echo \'{"stage":"data","ok":true,"stalledAtKb":null}\'',
      'elif [ -n "$stalled" ]; then',
      '  printf \'{"stage":"data","ok":false,"stalledAtKb":%s}\\n\' "$stalled"',
      'else',
      '  echo \'{"stage":"data","ok":true,"stalledAtKb":null}\'',
      'fi',
    ].join('\n'),
  );
}

interface RawBlockOutput {
  stage: 'tcp' | 'port' | 'tls' | 'data';
  ok: boolean;
  stalledAtKb: number | null;
}

function isRawBlockOutput(v: unknown): v is RawBlockOutput {
  if (!v || typeof v !== 'object') return false;
  const r = v as Record<string, unknown>;
  return (
    (r.stage === 'tcp' || r.stage === 'port' || r.stage === 'tls' || r.stage === 'data') &&
    typeof r.ok === 'boolean' &&
    (r.stalledAtKb === null || typeof r.stalledAtKb === 'number')
  );
}

/** Разобрать вывод одного прогона в понятный человеку результат пробы. */
export function parseBlockCheckOutput(from: string, stdout: string): BlockProbeResult {
  const line = stdout
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.startsWith('{'));
  let parsed: unknown;
  try {
    parsed = line ? JSON.parse(line) : null;
  } catch {
    parsed = null;
  }
  if (!isRawBlockOutput(parsed))
    return {
      from,
      verdict: 'unreachable',
      detail: 'Проверка не вернула результата.',
      stalledAtKb: null,
      error: 'Пустой или неразобранный ответ.',
    };
  if (parsed.stage === 'tcp' && !parsed.ok)
    return {
      from,
      verdict: 'unreachable',
      detail: 'Порт не отвечает совсем.',
      stalledAtKb: null,
      error: null,
    };
  if (parsed.stage === 'port')
    return {
      from,
      verdict: 'ok',
      detail: 'Порт отвечает. Проверить блокировку ТСПУ и «16–20 КБ» нельзя: неизвестно имя маскировки ноды.',
      stalledAtKb: null,
      error: null,
    };
  if (parsed.stage === 'tls' && !parsed.ok)
    return {
      from,
      verdict: 'tspu',
      detail:
        'Порт открыт, но TLS-подключение с именем маскировки ноды тихо обрывается без ответа сертификата.',
      stalledAtKb: null,
      error: null,
    };
  if (parsed.stage === 'data' && !parsed.ok && parsed.stalledAtKb !== null)
    return {
      from,
      verdict:
        parsed.stalledAtKb >= BLOCK_1620_MIN_KB && parsed.stalledAtKb <= BLOCK_1620_MAX_KB
          ? 'block_16_20'
          : 'ok',
      detail: `Соединение тихо обрывается на объёме около ${parsed.stalledAtKb} КБ без явного отказа.`,
      stalledAtKb: parsed.stalledAtKb,
      error: null,
    };
  return {
    from,
    verdict: 'ok',
    detail: 'TLS-подключение и передача данных прошли без обрывов.',
    stalledAtKb: null,
    error: null,
  };
}

/**
 * Итог по всем пробам вместе: если хоть одна проба уверенно назвала блокировку — это и есть вердикт
 * (единичное «ok» с соседнего сервера не отменяет находку — блокировка может быть избирательной по
 * маршруту/провайдеру, это ожидаемо и не противоречие). Иначе — самый частый вердикт по пробам.
 */
export function combineVerdicts(probes: BlockProbeResult[]): BlockVerdict {
  if (probes.length === 0) return 'unreachable';
  const priority: BlockVerdict[] = ['block_16_20', 'tspu', 'ip_block', 'unreachable', 'ok'];
  for (const v of priority) if (probes.some((p) => p.verdict === v)) return v;
  return 'ok';
}

/** «Порт не отвечает совсем.» → «порт не отвечает совсем» — для строки списка. */
const probeLine = (p: BlockProbeResult): string => {
  const d = p.detail.trim().replace(/\.+$/, '');
  // Строчная первая буква — только у обычного слова: «TLS-подключение» так и остаётся.
  const lower = /^[А-ЯЁA-Z][а-яёa-z]/.test(d) ? `${d.charAt(0).toLowerCase()}${d.slice(1)}` : d;
  return `• ${p.from} — ${lower}`;
};

/**
 * Заголовок и текст инцидента «резко упал онлайн» блоками (витрина `telegram-messages-variants.html`, 1A):
 * цифры онлайна, откуда проверяли и что увидели, вывод. Тот же текст — в карточке инцидента и в Telegram.
 */
export function describeAnomaly(input: {
  nodeName: string;
  before: number;
  after: number;
  windowMin: number;
  result: BlockCheckResult;
  portKnown: boolean;
}): { title: string; detail: string; confirmed: boolean } {
  const { nodeName, before, after, windowMin, result } = input;
  const pct = before > 0 ? Math.round(((before - after) / before) * 100) : 0;
  const lines = [`Онлайн: ${before} → ${after} (−${pct} %) за ${windowMin} минут`];
  const confirmed = result.probes.length > 0 && result.verdict !== 'ok';
  const rental = /аренд|rent/i.test(nodeName);
  let title: string;
  if (result.probes.length === 0) {
    title = `Резко упал онлайн, проверить не удалось · ${nodeName}`;
    lines.push(
      '',
      input.portKnown
        ? 'Проверить не удалось: нет ни одного российского сервера парка с рабочим SSH для встречной проверки.'
        : 'Проверить не удалось: в Remnawave не нашёлся порт подключения этой ноды.',
    );
    return { title, detail: lines.join('\n'), confirmed };
  }
  lines.push('', 'Из России:', ...result.probes.map(probeLine));
  if (result.foreign.length > 0) lines.push('Из-за рубежа:', ...result.foreign.map(probeLine));
  const portOnly = result.sniUsed === null;
  let verdict: string;
  switch (result.verdict) {
    case 'ip_block':
      verdict = 'Похоже: блокировка IP на стороне России — сервер жив. Обычно помогает только смена IP.';
      break;
    case 'unreachable':
      verdict =
        result.foreign.length > 0
          ? 'Похоже: сервер выключен, отключён хостером или арендодателем, либо закрыт firewall.'
          : 'Похоже: из России порт не отвечает; проверить из-за рубежа нечем — нет зарубежных серверов парка с рабочим SSH.';
      break;
    case 'tspu':
      verdict = 'Похоже: блокировка ТСПУ — подключение с именем маскировки обрывается без ответа.';
      break;
    case 'block_16_20':
      verdict = 'Похоже: блок «16–20 КБ» — соединение рвётся после первых килобайт.';
      break;
    default:
      verdict = portOnly
        ? 'Вывод: порт отвечает. Блокировку ТСПУ и «16–20 КБ» проверить нельзя: в Remnawave нет имени маскировки этой ноды.'
        : 'Вывод: блокировка не подтвердилась — возможно, сбой у провайдеров пользователей.';
  }
  lines.push('', verdict);
  if (rental && result.verdict === 'unreachable')
    lines.push('Сервер арендован: если он недоступен целиком, возможно, не оплачена аренда.');
  title = confirmed
    ? `${BLOCK_VERDICT_LABELS[result.verdict]} · ${nodeName}`
    : portOnly
      ? `Резко упал онлайн, порт отвечает · ${nodeName}`
      : `Резко упал онлайн, блокировка не подтвердилась · ${nodeName}`;
  return { title, detail: lines.join('\n'), confirmed };
}
