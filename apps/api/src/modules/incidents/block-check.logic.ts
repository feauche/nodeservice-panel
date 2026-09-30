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
  type BlockUncheckedReason,
  type BlockVerdict,
  type Server,
} from '@nodeservice/shared';

import { lowerFirst } from '../../common/text.js';
import { SH } from './actions.registry.js';
import {
  NO_PAYMENT_FACTS,
  ONLINE_DROP_PAYMENT_TITLE,
  type PaymentFacts,
  type PaymentPicture,
  paymentConclusion,
  paymentLines,
  paymentTitled,
  rentalGuess,
  serverDownLabel,
} from './payment-hint.js';

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

/**
 * Зарубежные серверы парка с рабочим SSH (страна известна и не Россия), не сама проверяемая нода —
 * по одному на страну: две Германии подряд ничего не добавляют, а Германия и Нидерланды — да.
 */
export function pickForeignProbes(
  excludeServerId: string | null,
  all: Pick<Server, 'id' | 'name' | 'sshOk' | 'country'>[],
  max = 3,
): Pick<Server, 'id' | 'name'>[] {
  const pool = all
    .filter(
      (s) =>
        s.id !== excludeServerId && s.sshOk === true && s.country.code !== null && s.country.code !== 'RU',
    )
    .sort((a, b) => a.name.localeCompare(b.name, 'ru'));
  return onePerCountry(pool, max);
}

/** По одному серверу из каждой страны (в порядке списка), потом добираем вторыми из тех же стран. */
function onePerCountry<T extends Pick<Server, 'country'>>(pool: T[], max: number): T[] {
  const seen = new Set<string>();
  const first: T[] = [];
  const rest: T[] = [];
  for (const s of pool) {
    const c = s.country.code ?? '?';
    if (seen.has(c)) rest.push(s);
    else {
      seen.add(c);
      first.push(s);
    }
  }
  return [...first, ...rest].slice(0, max);
}

/**
 * Проверяющие «из каждой страны» для вопроса «жив ли сервер»: Россия первой (там блокируют чаще всего),
 * дальше по одной стране; сама проверяемая машина не участвует.
 */
export function pickCountryProbes(
  excludeServerId: string | null,
  all: Pick<Server, 'id' | 'name' | 'sshOk' | 'country'>[],
  max = 6,
): Array<Pick<Server, 'id' | 'name' | 'country'>> {
  const pool = all
    .filter((s) => s.id !== excludeServerId && s.sshOk === true && s.country.code !== null)
    .sort((a, b) => {
      const ra = a.country.code === 'RU' ? 0 : 1;
      const rb = b.country.code === 'RU' ? 0 : 1;
      return ra - rb || a.name.localeCompare(b.name, 'ru');
    });
  const one = onePerCountry(pool, pool.length);
  const countries = new Set(one.map((s) => s.country.code));
  return one.slice(0, Math.min(countries.size, max));
}

/** Результат проверки «из каждой страны»: откуда порт открыт, откуда нет. */
export interface CountryReach {
  from: string;
  country: string | null;
  open: boolean;
}

/**
 * Строки для дела: «Открыт: 🇩🇪 Германия - 1, 🇳🇱 …» / «Закрыт: …» не флагами (флаги рисует панель), а
 * по одному серверу на строку, как в проверке блокировки: «• Германия - 1 — порт открыт».
 */
export function countryReachLines(results: CountryReach[], panelOpen: boolean | null): string[] {
  const lines = results.map((r) => `• ${r.from} — ${r.open ? 'порт открыт' : 'порт не отвечает'}`);
  if (panelOpen !== null) lines.push(`• Сервер панели — ${panelOpen ? 'порт открыт' : 'порт не отвечает'}`);
  return lines;
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
      // Шаг 1: обычный TCP-порт — если недоступен вообще, дальше проверять нечего. Адрес и порт
      // подставляет внешняя оболочка: во вложенном bash переменных addr и port нет (они не экспортированы),
      // и с «\$addr» проверка всегда шла на пустой адрес — «порт не отвечает» отовсюду (случай «Казахстан-1»).
      // Подставлять безопасно: форма адреса проверена isSafeBlockCheckTarget, порт — число.
      `if ! timeout ${BLOCK_CHECK_CONNECT_TIMEOUT_SEC} bash -c "exec 3<>/dev/tcp/$addr/$port" 2>/dev/null; then`,
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

/**
 * Разобрать вывод одного прогона в понятный человеку результат пробы. `portOnlyByDesign` — проверка только
 * порта по замыслу (встречная из-за рубежа, вход): оговорка «неизвестно имя маскировки» там была бы
 * неправдой — имя известно, его просто не используют.
 */
export function parseBlockCheckOutput(
  from: string,
  stdout: string,
  portOnlyByDesign = false,
): BlockProbeResult {
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
      detail: portOnlyByDesign
        ? 'Порт отвечает.'
        : 'Порт отвечает. Проверить блокировку ТСПУ и «16–20 КБ» нельзя: неизвестно имя маскировки ноды.',
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
 * Проба что-то увидела у цели. Сбой входа на проверяющий сервер и ответ, который не удалось разобрать
 * (команда на проверяющем не отработала), о цели ничего не говорят — «порт закрыт» по ним сказать нельзя.
 */
export const probeSaw = (p: BlockProbeResult): boolean => p.error === null;

/** Почему ни одна проба ничего не увидела: панель не зашла ни на один проверяющий или проверка не отработала. */
export const blindReason = (probes: BlockProbeResult[]): 'ssh' | 'no_answer' =>
  probes.every((p) => p.error === 'ssh') ? 'ssh' : 'no_answer';

/** Вердикты, которые называет и одна проба: блокировка избирательна по маршруту и провайдеру. */
const BLOCK_FIRST: readonly BlockVerdict[] = ['block_16_20', 'tspu', 'ip_block'];

/**
 * Итог по пробам с РАЗНЫХ серверов. Блокировку по протоколу («16–20 КБ», ТСПУ) называет и одна проба:
 * единичное «ok» с соседнего сервера находку не отменяет — блокировка избирательна. А вот «порт не
 * отвечает» одного проверяющего ответивших не перевешивает: часть дошла, часть нет — это `partial`
 * («порт отвечает с перебоями»), а не «сервер недоступен» и не «блокировка IP из России». Проверяющий,
 * который сам подключался не каждый раз (его итог — `partial`), считается и ответившим, и молчавшим.
 */
export function combineVerdicts(probes: BlockProbeResult[]): BlockVerdict {
  if (probes.length === 0) return 'unreachable';
  for (const v of BLOCK_FIRST) if (probes.some((p) => p.verdict === v)) return v;
  const answered = probes.some((p) => p.verdict === 'ok' || p.verdict === 'partial');
  const silent = probes.some((p) => p.verdict !== 'ok');
  if (answered && silent) return 'partial';
  return answered ? 'ok' : 'unreachable';
}

/** Ничья между попытками ОДНОГО сервера: худший вердикт по порядку (блокировка → не отвечает → в норме). */
function worstOf(attempts: BlockProbeResult[]): BlockVerdict {
  for (const v of [...BLOCK_FIRST, 'unreachable'] as const)
    if (attempts.some((a) => a.verdict === v)) return v;
  return 'ok';
}

/**
 * Итог нескольких попыток с ОДНОГО сервера. Ложных выводов быть не должно (требование владельца):
 * - попытка, в которой панель не зашла на сам проверяющий сервер или получила неразборчивый ответ, о цели
 *   ничего не говорит — не считается;
 * - проверка только порта: одно удачное подключение — доказательство, что порт открыт (сбой одной попытки
 *   не делает его «закрытым»);
 * - полная проверка (TLS и данные): большинство попыток, ничья — худший вердикт (см. worstOf);
 * - та же точка то подключается, то нет: «порт не отвечает совсем» про неё сказать нельзя — она же только что
 *   подключилась. Итог такой точки — «отвечает не каждый раз» (`partial`), а не закрытый порт.
 * null — ни одна попытка не дошла до цели (проверить не удалось).
 */
export function settleAttempts(attempts: BlockProbeResult[], portOnly: boolean): BlockProbeResult | null {
  const valid = attempts.filter(probeSaw);
  if (valid.length === 0) return null;
  if (portOnly) return valid.find((a) => a.verdict === 'ok') ?? (valid[0] as BlockProbeResult);
  const counts = new Map<BlockVerdict, number>();
  for (const a of valid) counts.set(a.verdict, (counts.get(a.verdict) ?? 0) + 1);
  const top = Math.max(...counts.values());
  const leaders = valid.filter((a) => counts.get(a.verdict) === top);
  const verdict = worstOf(leaders);
  const answered = counts.get('ok') ?? 0;
  if (verdict === 'unreachable' && answered > 0)
    return {
      from: (valid[0] as BlockProbeResult).from,
      verdict: 'partial',
      detail: `Порт отвечает не каждый раз: удачных попыток ${answered} из ${valid.length}.`,
      stalledAtKb: null,
      error: null,
    };
  return leaders.find((a) => a.verdict === verdict) ?? (valid[0] as BlockProbeResult);
}

/**
 * Итог проверки входа (только порт, без ложных выводов): проверяющий, на который панель не зашла, о входе
 * ничего не говорит — не считается; одно удачное подключение — вход открыт (отключённый вход не ответил бы
 * никому). Никто не дошёл — проб нет: «проверить не удалось», а не «вход молчит».
 */
export function settleEntry(probes: BlockProbeResult[]): {
  probes: BlockProbeResult[];
  verdict: BlockVerdict;
} {
  const valid = probes.filter(probeSaw);
  return { probes: valid, verdict: valid.some((p) => p.verdict === 'ok') ? 'ok' : 'unreachable' };
}

/** «Порт не отвечает совсем.» → «порт не отвечает совсем» — для строки списка. */
const probeLine = (p: BlockProbeResult): string => {
  const d = p.detail.trim().replace(/\.+$/, '');
  // Строчная первая буква — только у обычного слова: «TLS-подключение» так и остаётся.
  return `• ${p.from} — ${lowerFirst(d)}`;
};

const BLOCKED: ReadonlySet<BlockVerdict> = new Set(['ip_block', 'tspu', 'block_16_20']);

/**
 * Почему проверка порта ноды не состоялась — настоящая причина, а не одна на все случаи. `portKnown` —
 * подсказка для результата без записанной причины: порт ноды в Remnawave нашёлся.
 */
export function uncheckedReason(
  result: Pick<BlockCheckResult, 'unchecked'>,
  portKnown = true,
): BlockUncheckedReason {
  return result.unchecked ?? (portKnown ? 'no_probers' : 'no_port');
}

const UNCHECKED_WHY: Record<BlockUncheckedReason, string> = {
  no_port: 'в Remnawave не нашёлся порт подключения этой ноды',
  bad_address: 'адрес, порт или имя маскировки этой ноды записаны в Remnawave с недопустимыми знаками',
  no_probers: 'нет ни одного российского сервера парка с рабочим SSH для встречной проверки',
  ssh: 'панель не зашла по SSH ни на один российский проверяющий сервер',
  no_answer: 'команда проверки на российских проверяющих серверах не вернула результата',
};

/** Что помешало проверке — с маленькой буквы, без точки: вставляется в середину фразы. */
export function uncheckedWhy(result: Pick<BlockCheckResult, 'unchecked'>, portKnown = true): string {
  return UNCHECKED_WHY[uncheckedReason(result, portKnown)];
}

/** Строка дела «проверить не удалось» с настоящей причиной. */
export function uncheckedLine(result: Pick<BlockCheckResult, 'unchecked'>, portKnown = true): string {
  return `Проверить не удалось: ${uncheckedWhy(result, portKnown)}.`;
}

/**
 * Строка о входе, который не проверяли: панель зашла на российский проверяющий (иначе не было бы проверки
 * выхода), поэтому «не зашла ни на один» — правда только когда проверяющие для входа были и не пустили.
 */
export function entryUncheckedLine(entry: NonNullable<BlockCheckResult['entry']>): string {
  const head = `${entry.label} (${entry.address})`;
  switch (entry.unchecked) {
    case 'bad_address':
      return `${head}: проверить нельзя — адрес входа в профиле сервера записан не как домен или IP-адрес с портом.`;
    case 'ssh':
      return `${head}: проверить не удалось — панель не зашла ни на один российский проверяющий сервер.`;
    case 'no_answer':
      return `${head}: проверить не удалось — команда проверки на российских проверяющих серверах не вернула результата.`;
    default:
      return `${head}: проверить не с чего — других российских серверов парка с рабочим SSH нет.`;
  }
}

const FOREIGN_WHY: Record<BlockUncheckedReason, string> = {
  no_port: 'проверить из-за рубежа нечем',
  bad_address: 'проверить из-за рубежа нечем',
  no_probers: 'проверить из-за рубежа нечем — нет зарубежных серверов парка с рабочим SSH',
  ssh: 'проверить из-за рубежа не удалось — панель не зашла ни на один зарубежный сервер парка',
  no_answer:
    'проверить из-за рубежа не удалось — команда проверки на зарубежных серверах парка не вернула результата',
};

/** Почему нет встречной проверки из-за рубежа — настоящая причина; для вставки в середину фразы. */
export function foreignWhy(result: Pick<BlockCheckResult, 'foreignUnchecked'>): string {
  return FOREIGN_WHY[result.foreignUnchecked ?? 'no_probers'];
}

/**
 * Чья сторона сломалась, если проверяли и вход: вход жив, а выход нет — и наоборот. `serverAlive` — агент
 * на связи: сервер работает, молчит только порт ноды. `bare` — только факт «выход отвечает, а вход нет»,
 * без совета «пишите арендодателю»: следом идёт вывод об оплате аренды (совет спорил бы с «проверьте оплату»)
 * либо текст читает Джарвис, которому, что советовать, говорят правила разбора. null — входа нет,
 * проверить его не удалось или сказать нечего.
 */
export function entrySide(
  result: BlockCheckResult,
  opts: { serverAlive?: boolean | undefined; bare?: boolean | undefined } = {},
): string | null {
  const entry = result.entry;
  if (!entry || entry.probes.length === 0) return null;
  const entryOk = entry.verdict === 'ok';
  const exitOk = result.verdict === 'ok';
  if (entryOk && exitOk) return null;
  // К кому идти, если дело во входе: арендованный — к арендодателю, свой мост — чинить самим.
  const toEntry = entry.rented
    ? `пишите арендодателю${entry.owner ? ` (${entry.owner})` : ''}`
    : 'проверьте сам мост';
  if (exitOk)
    return opts.bare
      ? 'Выход отвечает, а вход — нет.'
      : `Выход отвечает, а вход — нет: похоже, лёг вход — ${toEntry}.`;
  // Выход жив, но из России его режет блокировка: порт отвечает, дело не в сервере.
  if (BLOCKED.has(result.verdict))
    return entryOk
      ? 'Вход отвечает, а выход из России режет блокировка — дело не в сервере и не в хостере: помогает смена IP или маскировки выхода.'
      : `Выход из России режет блокировка, и вход не отвечает. Начните с выхода: смена IP или маскировки; если вход после этого не ответит — ${toEntry}.`;
  // Выход отвечает с перебоями: сервер работает, о входе при исправном входе добавить нечего.
  if (result.verdict === 'partial')
    return entryOk
      ? null
      : `Вход не отвечает, а выход отвечает с перебоями. Вход может молчать потому, что до выхода не достаёт и он, — начните с выхода; если выход заработает без перебоев, а вход нет — ${toEntry}.`;
  const alive = Boolean(opts.serverAlive);
  // Из-за рубежа не проверяли: блокировку IP из России от сбоя на самом сервере панель отличить не может.
  if (result.foreign.length === 0) {
    if (entryOk)
      return alive
        ? 'Вход отвечает, а порт ноды на выходе из России — нет; из-за рубежа порт не проверен: это либо блокировка IP выхода из России, либо нода не слушает порт.'
        : 'Вход отвечает, а выход из России — нет; из-за рубежа порт не проверен: это либо блокировка IP выхода из России, либо выход недоступен целиком.';
    return alive
      ? `Не отвечают ни порт ноды на выходе (из России), ни вход; из-за рубежа порт не проверен. Сервер работает (агент на связи): это либо блокировка IP выхода из России, либо нода не слушает порт. Вход, скорее всего, молчит по той же причине — начните с выхода; если порт заработает, а вход нет — ${toEntry}.`
      : `Не отвечают ни выход (из России), ни вход; из-за рубежа порт не проверен. Вход, скорее всего, молчит потому, что не достаёт до выхода, — начните с выхода: работает ли сервер (кабинет хостера) и не закрыт ли его IP из России. Если выход поднимется, а вход нет — ${toEntry}.`;
  }
  if (entryOk)
    return alive
      ? 'Вход отвечает, а порт ноды на выходе — нет: сервер работает, дело в самой ноде — она не слушает порт или его закрыл файрвол.'
      : 'Вход отвечает, не отвечает выход — дело в этом сервере или его хостере.';
  // Вход обычно просто пересылает соединения на этот выход: пока лежит выход, молчит и вход.
  // Винить вход по этому нельзя — начинаем с выхода, а ко входу — если выход поднимется, а вход нет.
  return alive
    ? `Не отвечают ни порт ноды на выходе, ни вход. Вход, скорее всего, молчит потому, что нода на выходе не принимает соединения, — начните с ноды на этом сервере. Если она заработает, а вход нет — ${toEntry}.`
    : `Не отвечают ни выход, ни вход. Вход, скорее всего, пересылает трафик на этот сервер и молчит, потому что лежит выход, — начните с выхода (хостер, оплата). Если выход поднимется, а вход нет — ${toEntry}.`;
}

/**
 * Заголовок и текст инцидента «резко упал онлайн» блоками (витрина `telegram-messages-variants.html`, 1A):
 * цифры онлайна, откуда проверяли и что увидели, вывод. Тот же текст — в карточке инцидента и в Telegram.
 * Оплата в окне (см. payment-hint.ts) — вероятная причина, пока блокировка не подтверждена: сервер
 * недоступен целиком, молчит арендованный вход или просто ничего другого не нашлось. Там, где панель
 * проверила не всё или уже нашла другое объяснение, она просит проверить оплату, но причиной её не называет.
 */
export function describeAnomaly(input: {
  nodeName: string;
  before: number;
  after: number;
  windowMin: number;
  result: BlockCheckResult;
  portKnown: boolean;
  /**
   * Оплаты сервера из «Биллинга», у которых срок прошёл или наступит в ближайшие сутки. null — «Биллинг»
   * не спрашивали (ноды нет среди серверов панели) или он не ответил: про оплату панель тогда не знает.
   */
  payment?: PaymentFacts | null | undefined;
  /** Агент на связи: сервер работает, даже если порт ноды не отвечает ниоткуда. */
  serverAlive?: boolean | undefined;
  /** У скольких ещё нод онлайн упал в то же время: общая причина вероятнее оплаты одного сервера. */
  othersDown?: number | undefined;
}): { title: string; detail: string; confirmed: boolean; kind: 'node_blocked' | 'server_down' } {
  const { nodeName, before, after, windowMin, result } = input;
  const payment = input.payment ?? null;
  const facts = payment ?? NO_PAYMENT_FACTS;
  const pct = before > 0 ? Math.round(((before - after) / before) * 100) : 0;
  const lines = [`Онлайн: ${before} → ${after} (−${pct} %) за ${windowMin} минут`];
  const confirmed = result.probes.length > 0 && result.verdict !== 'ok';
  const rental = /аренд|rent/i.test(nodeName);
  const agentOn = Boolean(input.serverAlive);
  const others = (input.othersDown ?? 0) > 0;
  /** Строки оплаты и вывод для картины; пусто — подходящей оплаты в окне нет. */
  const hintFor = (picture: PaymentPicture | null): string[] => {
    const text = picture ? paymentConclusion(facts, picture) : null;
    return picture && text ? ['', ...paymentLines(facts, picture), text] : [];
  };
  if (result.probes.length === 0) {
    lines.push('', uncheckedLine(result, input.portKnown));
    // Проверки нет — причину не называем, но оплату в окне просим посмотреть. Агент на связи — сервер
    // работает, хостер его не отключал: остаётся аренда.
    const picture: PaymentPicture = others
      ? agentOn
        ? 'fleet'
        : 'fleet-dark'
      : agentOn
        ? 'unchecked-alive'
        : 'unchecked';
    lines.push(...hintFor(picture));
    return {
      title: `${paymentTitled(facts, picture) ? ONLINE_DROP_PAYMENT_TITLE : 'Резко упал онлайн, проверить не удалось'} · ${nodeName}`,
      detail: lines.join('\n'),
      confirmed,
      kind: 'node_blocked',
    };
  }
  const entry = result.entry;
  lines.push('', entry ? 'Выход — этот сервер, из России:' : 'Из России:', ...result.probes.map(probeLine));
  if (result.foreign.length > 0) lines.push('Из-за рубежа:', ...result.foreign.map(probeLine));
  if (entry && entry.probes.length > 0)
    lines.push('', `${entry.label} (${entry.address}), из России:`, ...entry.probes.map(probeLine));
  else if (entry) lines.push('', entryUncheckedLine(entry));
  const portOnly = result.sniUsed === null;
  const unreachable = result.verdict === 'unreachable';
  const partial = result.verdict === 'partial';
  // Порт ноды молчит, а агент на связи: сервер работает — это не отключение и не неоплата.
  const alive = unreachable && agentOn;
  const abroad = result.foreign.length > 0;
  const entryChecked = Boolean(entry && entry.probes.length > 0);
  // Сервер отвечает, а вход — нет: причина уже видна, и это не «сбой у провайдеров пользователей».
  const entryDown = result.verdict === 'ok' && entryChecked && entry?.verdict !== 'ok';
  // Свой мост проверить не удалось: возможная причина не проверена — «другой причины не нашлось» сказать нельзя.
  const ownEntryUnknown = Boolean(entry && !entryChecked && !entry.rented);
  // Итог «в норме», но у какой-то пробы соединение оборвалось на небольшом объёме (вне признака «16–20 КБ»):
  // это тоже находка, и «другой причины панель не нашла» при ней сказать нельзя.
  const stalled = result.verdict === 'ok' && result.probes.some((p) => p.stalledAtKb !== null);
  // Оплата — возможная причина, только пока блокировка не подтверждена. Молчит свой мост — причина в нём,
  // а не в оплате этого сервера; молчит арендованный вход — так и выглядит неоплаченная аренда.
  let picture: PaymentPicture | null = null;
  if (unreachable) picture = alive ? null : others ? 'fleet-dark' : abroad ? 'down' : 'ru-only';
  else if (partial) picture = others ? 'fleet' : 'partial';
  else if (result.verdict === 'ok') {
    if (entryDown) picture = entry?.rented ? 'entry' : null;
    else if (others) picture = 'fleet';
    else if (stalled) picture = 'stalled';
    else if (ownEntryUnknown) picture = 'entry-unchecked';
    else picture = portOnly ? 'port-only' : 'nothing';
  }
  const hint = hintFor(picture);
  const titled = picture !== null && paymentTitled(facts, picture);
  let verdict: string;
  switch (result.verdict) {
    case 'ip_block':
      verdict = 'Похоже: блокировка IP на стороне России — сервер жив. Обычно помогает только смена IP.';
      break;
    case 'unreachable':
      if (alive)
        verdict = abroad
          ? 'Похоже: сервер работает (агент на связи), а порт ноды не отвечает ни из России, ни из-за рубежа — нода не слушает порт или его закрыл файрвол.'
          : `Похоже: сервер работает (агент на связи), а порт ноды из России не отвечает; ${foreignWhy(result)}.`;
      else
        verdict = abroad
          ? 'Похоже: сервер выключен, отключён хостером или арендодателем, либо закрыт firewall.'
          : `Похоже: из России порт не отвечает; ${foreignWhy(result)}.`;
      break;
    case 'partial':
      verdict =
        'Похоже: порт ноды отвечает с перебоями — не со всех российских проверяющих серверов или не каждый раз. Сервер работает, но из части сетей до него не достучаться: блокировка у части провайдеров или сбой маршрута.';
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
        : stalled
          ? 'Вывод: признаков блокировки ТСПУ и «16–20 КБ» нет, но соединение с нодой обрывается на небольшом объёме данных — возможны помехи на пути.'
          : entryDown || titled
            ? 'Вывод: блокировка не подтвердилась.'
            : 'Вывод: блокировка не подтвердилась — возможно, сбой у провайдеров пользователей.';
  }
  lines.push('', verdict);
  const side = entrySide(result, {
    serverAlive: alive,
    bare: picture === 'entry' && hint.length > 0,
  });
  if (side) lines.push(side);
  if (hint.length > 0) lines.push(...hint);
  else if (rental && unreachable && !alive) {
    const guess = rentalGuess(payment);
    if (guess) lines.push(guess);
  }
  // Сервер не отвечает ни из России, ни из-за рубежа — это не блокировка, а недоступность целиком.
  if (unreachable && abroad && !alive)
    return {
      title: `${(picture ? serverDownLabel(facts, picture) : undefined) ?? 'Сервер недоступен'} · ${nodeName}`,
      detail: lines.join('\n'),
      confirmed,
      kind: 'server_down',
    };
  let title: string;
  if (alive) title = 'Резко упал онлайн, порт ноды не отвечает';
  // Из-за рубежа порт не проверен: оплату в заголовок ставим, но сервер «недоступным» не называем — это
  // может быть и блокировка IP из России.
  else if (unreachable)
    title = titled ? ONLINE_DROP_PAYMENT_TITLE : 'Резко упал онлайн, порт из России не отвечает';
  else if (partial) title = 'Резко упал онлайн, порт отвечает с перебоями';
  else if (confirmed) title = BLOCK_VERDICT_LABELS[result.verdict];
  else if (titled) title = ONLINE_DROP_PAYMENT_TITLE;
  else
    title = portOnly ? 'Резко упал онлайн, порт отвечает' : 'Резко упал онлайн, блокировка не подтвердилась';
  return { title: `${title} · ${nodeName}`, detail: lines.join('\n'), confirmed, kind: 'node_blocked' };
}
