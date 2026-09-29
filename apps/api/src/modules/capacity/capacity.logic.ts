import {
  CAPACITY_LIMIT_PCT,
  CAPACITY_MIN_DAYS,
  CAPACITY_MIN_ONLINE,
  type CapacityCell,
  type CapacityResource,
  type CapacityStatus,
  formatMbit,
  type ServerLink,
} from '@nodeservice/shared';

/* ─────────── канал: сетевая карта по SSH ─────────── */

/**
 * Сетевая карта маршрута по умолчанию: имя, скорость порта, драйвер и виртуализация; предел соединений ядра.
 * Только читает.
 */
export const LINK_PROBE_COMMAND = [
  `dev=$(ip route show default 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="dev"){print $(i+1); exit}}')`,
  'echo "@@dev=$dev"',
  'echo "@@speed=$(cat /sys/class/net/$dev/speed 2>/dev/null)"',
  'echo "@@driver=$(basename "$(readlink /sys/class/net/$dev/device/driver 2>/dev/null)" 2>/dev/null)"',
  'echo "@@virt=$(systemd-detect-virt 2>/dev/null)"',
  'echo "@@ctmax=$(cat /proc/sys/net/netfilter/nf_conntrack_max 2>/dev/null)"',
].join('; ');

/** Драйверы виртуальных сетевых карт: у них «скорость порта» — условная цифра, а не полоса хостера. */
const VIRTUAL_DRIVERS = /virtio|vmxnet|netvsc|xen|ena|gve|e1000|veth|tun|vif/i;

export interface LinkProbe {
  nicName: string | null;
  nicMbit: number | null;
  nicVirtual: boolean | null;
  conntrackMax: number | null;
}

const field = (out: string, name: string): string | null => {
  const m = new RegExp(`^@@${name}=(.*)$`, 'm').exec(out);
  const v = m?.[1]?.trim();
  return v ? v : null;
};
const posInt = (v: string | null): number | null => {
  const x = Number(v);
  return Number.isFinite(x) && x > 0 ? Math.round(x) : null;
};

export function parseLinkProbe(out: string): LinkProbe {
  const driver = field(out, 'driver');
  const virt = field(out, 'virt');
  const nicName = field(out, 'dev');
  const virtual =
    driver || virt ? Boolean((driver && VIRTUAL_DRIVERS.test(driver)) || (virt && virt !== 'none')) : null;
  return {
    nicName,
    nicMbit: posInt(field(out, 'speed')),
    nicVirtual: virtual,
    conntrackMax: posInt(field(out, 'ctmax')),
  };
}

/* ─────────── канал: замер скорости ─────────── */

export const SPEED_TEST_SECONDS = 8;
/** Предел на поток и направление: не больше ≈ 1 ГБ в каждую сторону даже на канале 10 Гбит. */
const STREAM_CAP_BYTES = 250_000_000;

/**
 * Замер: 4 потока загрузки, затем 4 потока отдачи, по 8 секунд, порциями до 90 МБ (больше сервис скорости
 * не отдаёт) через speed.cloudflare.com. curl при обрыве по времени всё равно сообщает, сколько успел.
 */
export function speedTestCommand(): string {
  const T = SPEED_TEST_SECONDS;
  const loop = (dir: 'down' | 'up') => {
    const req =
      dir === 'down'
        ? `curl --max-time ${T} -s -o /dev/null -w '%{size_download}' 'https://speed.cloudflare.com/__down?bytes=90000000'`
        : `head -c 90000000 /dev/zero | curl --max-time ${T} -s -o /dev/null -T - -X POST -w '%{size_upload}' https://speed.cloudflare.com/__up`;
    return `for i in 1 2 3 4; do ( s=$(date +%s); t=0; while [ $(( $(date +%s) - s )) -lt ${T} ] && [ $t -lt ${STREAM_CAP_BYTES} ]; do b=$(${req} 2>/dev/null); b=\${b%%.*}; t=$((t + \${b:-0})); done; echo $t > $d/${dir}$i ) & done; wait`;
  };
  return [
    'command -v curl >/dev/null || { echo "@@error=нет curl"; exit 0; }',
    'd=$(mktemp -d)',
    's0=$(date +%s%N)',
    loop('down'),
    's1=$(date +%s%N)',
    loop('up'),
    's2=$(date +%s%N)',
    `echo "@@down=$(awk '{s+=$1} END {print s+0}' $d/down*)"`,
    `echo "@@up=$(awk '{s+=$1} END {print s+0}' $d/up*)"`,
    'echo "@@downms=$(( (s1 - s0) / 1000000 ))"',
    'echo "@@upms=$(( (s2 - s1) / 1000000 ))"',
    'rm -rf "$d"',
  ].join('\n');
}

/** Мбит/с по замеру; null — замер не получился (нет curl, сервис скорости недоступен). */
export function parseSpeedTest(out: string): {
  downMbit: number | null;
  upMbit: number | null;
  error: string | null;
} {
  const err = field(out, 'error');
  if (err) return { downMbit: null, upMbit: null, error: err };
  const last = (name: string) => {
    const all = [...out.matchAll(new RegExp(`^@@${name}=(.*)$`, 'gm'))];
    return Number(all.at(-1)?.[1]);
  };
  const mbit = (bytes: number, ms: number) =>
    Number.isFinite(bytes) && Number.isFinite(ms) && bytes > 0 && ms > 0
      ? Math.round((bytes * 8) / ms / 1000)
      : null;
  const down = mbit(last('down'), last('downms'));
  const up = mbit(last('up'), last('upms'));
  return {
    downMbit: down,
    upMbit: up,
    error: down == null && up == null ? 'сервис скорости не ответил' : null,
  };
}

/* ─────────── канал: что берём в расчёт ─────────── */

export interface LinkRowLike {
  nicName: string | null;
  nicMbit: number | null;
  nicVirtual: boolean | null;
  conntrackMax: number | null;
  probedAt: Date | null;
  measuredDownMbit: number | null;
  measuredUpMbit: number | null;
  measuredAt: Date | null;
  manualMbit: number | null;
}

/**
 * Скорость канала по приоритету: вручную → замер → сетевая карта (только настоящая: у виртуальной скорость
 * порта условная, хостер режет полосу снаружи) → неизвестно.
 */
export function effectiveLink(row: LinkRowLike | null): ServerLink {
  const base = {
    nicName: row?.nicName ?? null,
    nicMbit: row?.nicMbit ?? null,
    nicVirtual: row?.nicVirtual ?? null,
    measuredDownMbit: row?.measuredDownMbit ?? null,
    measuredUpMbit: row?.measuredUpMbit ?? null,
    measuredAt: row?.measuredAt?.toISOString() ?? null,
    manualMbit: row?.manualMbit ?? null,
    conntrackMax: row?.conntrackMax ?? null,
    probedAt: row?.probedAt?.toISOString() ?? null,
  };
  if (row?.manualMbit) return { ...base, downMbit: row.manualMbit, upMbit: row.manualMbit, source: 'manual' };
  if (row?.measuredDownMbit || row?.measuredUpMbit) {
    const d = row.measuredDownMbit ?? row.measuredUpMbit;
    const u = row.measuredUpMbit ?? row.measuredDownMbit;
    return { ...base, downMbit: d, upMbit: u, source: 'measured' };
  }
  if (row?.nicMbit && row.nicVirtual === false)
    return { ...base, downMbit: row.nicMbit, upMbit: row.nicMbit, source: 'nic' };
  return { ...base, downMbit: null, upMbit: null, source: 'none' };
}

/* ─────────── расчёт ─────────── */

/** Прямая y = a + k·x методом наименьших квадратов; r2 — насколько нагрузка следует за онлайном. */
export function fitLine(xs: number[], ys: number[]): { a: number; k: number; r2: number } | null {
  const n = xs.length;
  if (n < 10) return null;
  let sx = 0;
  let sy = 0;
  for (let i = 0; i < n; i += 1) {
    sx += xs[i] as number;
    sy += ys[i] as number;
  }
  const mx = sx / n;
  const my = sy / n;
  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  for (let i = 0; i < n; i += 1) {
    const dx = (xs[i] as number) - mx;
    const dy = (ys[i] as number) - my;
    sxx += dx * dx;
    sxy += dx * dy;
    syy += dy * dy;
  }
  if (sxx === 0) return null;
  const k = sxy / sxx;
  const a = my - k * mx;
  const r2 = syy === 0 ? 0 : (sxy * sxy) / (sxx * syy);
  return { a, k, r2 };
}

/** Точки одного сервера на общей сетке времени: онлайн и нагрузка. */
export interface CapacitySeries {
  /** Отметки времени, секунды. */
  t: number[];
  online: Array<number | null>;
  cpu: Array<number | null>;
  mem: Array<number | null>;
  /** Трафик, Мбит/с: загрузка и отдача. */
  rx: Array<number | null>;
  tx: Array<number | null>;
  conn: Array<number | null>;
}

export interface CapacityResult {
  status: CapacityStatus;
  onlinePeak: number | null;
  peakAt: number | null;
  left: number | null;
  bottleneck: CapacityResource | null;
  cells: Record<CapacityResource, CapacityCell>;
  note: string | null;
}

const emptyCell = (r: CapacityResource, detail: string | null = null): CapacityCell => ({
  usedPct: null,
  limitPct: CAPACITY_LIMIT_PCT[r],
  left: null,
  detail,
});

/**
 * Сколько ещё людей выдержит сервер. Для каждого ресурса: прямая «нагрузка = фон + на одного × онлайн»
 * по точкам с людьми; «ещё влезет» = (потолок − нагрузка в пик) ÷ на одного. Упор — наименьшее.
 */
export function computeCapacity(s: CapacitySeries, link: ServerLink, stepSec: number): CapacityResult {
  const idx = s.online.map((v, i) => (v != null && v > 0 ? i : -1)).filter((i) => i >= 0);
  const blank: Record<CapacityResource, CapacityCell> = {
    cpu: emptyCell('cpu'),
    mem: emptyCell('mem'),
    net: emptyCell('net'),
    conn: emptyCell('conn'),
  };
  if (idx.length === 0)
    return {
      status: 'no_online',
      onlinePeak: null,
      peakAt: null,
      left: null,
      bottleneck: null,
      cells: blank,
      note: 'Онлайна на этой ноде за 14 дней не было.',
    };
  let pi = idx[0] as number;
  for (const i of idx) if ((s.online[i] as number) > (s.online[pi] as number)) pi = i;
  const onlinePeak = Math.round(s.online[pi] as number);
  const peakAt = s.t[pi] ?? null;
  const days = (idx.length * stepSec) / 86_400;
  if (days < CAPACITY_MIN_DAYS || onlinePeak < CAPACITY_MIN_ONLINE)
    return {
      status: 'few_data',
      onlinePeak,
      peakAt,
      left: null,
      bottleneck: null,
      cells: blank,
      note:
        days < CAPACITY_MIN_DAYS
          ? `Мало данных: онлайн есть за ${days.toFixed(1).replace('.', ',')} дн., нужно хотя бы ${CAPACITY_MIN_DAYS}.`
          : `Мало людей: в пик ${onlinePeak} онлайн, для оценки нужно хотя бы ${CAPACITY_MIN_ONLINE}.`,
    };

  // Трафик: какое направление нагружено сильнее относительно канала — то и считаем.
  const peakOf = (arr: Array<number | null>) => Math.max(0, ...arr.filter((v): v is number => v != null));
  const txUse = link.upMbit ? peakOf(s.tx) / link.upMbit : peakOf(s.tx);
  const rxUse = link.downMbit ? peakOf(s.rx) / link.downMbit : peakOf(s.rx);
  const useTx = txUse >= rxUse;
  const net = useTx ? s.tx : s.rx;
  const netLink = useTx ? link.upMbit : link.downMbit;

  const series: Record<CapacityResource, { y: Array<number | null>; cap: number | null }> = {
    cpu: { y: s.cpu, cap: 100 },
    mem: { y: s.mem, cap: 100 },
    net: { y: net, cap: netLink },
    conn: { y: s.conn, cap: link.conntrackMax },
  };
  const cells = { ...blank };
  let weakBase = false;
  for (const r of ['cpu', 'mem', 'net', 'conn'] as const) {
    const { y, cap } = series[r];
    const xs: number[] = [];
    const ys: number[] = [];
    for (const i of idx) {
      const v = y[i];
      if (v != null && Number.isFinite(v)) {
        xs.push(s.online[i] as number);
        ys.push(v);
      }
    }
    const atPeak = y[pi] ?? null;
    if (atPeak == null || ys.length < 10) {
      cells[r] = emptyCell(r, r === 'net' && !cap ? 'канал неизвестен' : null);
      continue;
    }
    const fit = fitLine(xs, ys);
    const usedPct = cap ? (atPeak / cap) * 100 : null;
    const detail =
      r === 'net'
        ? cap
          ? pairMbit(atPeak, cap)
          : `${formatMbit(atPeak)} · канал неизвестен`
        : r === 'conn' && cap
          ? `${thousands(atPeak)} из ${thousands(cap)}`
          : null;
    if (!cap || !fit || fit.k <= 0) {
      cells[r] = {
        usedPct: usedPct == null ? null : round1(usedPct),
        limitPct: CAPACITY_LIMIT_PCT[r],
        left: null,
        detail,
      };
      continue;
    }
    // Фон — нагрузка без людей; для процессора и памяти — признак слабого сервера.
    if ((r === 'cpu' || r === 'mem') && fit.a > 50) weakBase = true;
    const limit = (cap * CAPACITY_LIMIT_PCT[r]) / 100;
    const left = Math.max(0, Math.floor((limit - atPeak) / fit.k));
    cells[r] = { usedPct: round1(usedPct as number), limitPct: CAPACITY_LIMIT_PCT[r], left, detail };
  }

  let bottleneck: CapacityResource | null = null;
  for (const r of ['cpu', 'mem', 'net', 'conn'] as const) {
    const l = cells[r].left;
    if (l == null) continue;
    if (bottleneck == null || l < (cells[bottleneck].left as number)) bottleneck = r;
  }
  const left = bottleneck ? (cells[bottleneck].left as number) : null;
  if (weakBase)
    return {
      status: 'weak',
      onlinePeak,
      peakAt,
      left,
      bottleneck,
      cells,
      note: 'Сервер слабоват для большого онлайна: даже без людей процессор или память заняты больше чем наполовину.',
    };
  return {
    status: 'ok',
    onlinePeak,
    peakAt,
    left,
    bottleneck,
    cells,
    note: bottleneck
      ? verdict(bottleneck, cells, link)
      : 'Нагрузка почти не растёт с онлайном — упора не видно.',
  };
}

const round1 = (v: number) => Math.round(v * 10) / 10;

/** «890 из 1000 Мбит/с», «2,1 из 10 Гбит/с» — коротко, чтобы влезало под полосу. */
export function pairMbit(used: number, cap: number): string {
  if (cap >= 10_000) {
    const g = (v: number) => (v / 1000).toLocaleString('ru-RU', { maximumFractionDigits: 1 });
    return `${g(used)} из ${g(cap)} Гбит/с`;
  }
  return `${Math.round(used)} из ${Math.round(cap)} Мбит/с`;
}
/** «47 тыс.», «950». */
const thousands = (v: number) =>
  v >= 10_000
    ? `${Math.round(v / 1000).toLocaleString('ru-RU')} тыс.`
    : Math.round(v).toLocaleString('ru-RU');

function verdict(
  b: CapacityResource,
  cells: Record<CapacityResource, CapacityCell>,
  link: ServerLink,
): string {
  const free = (['cpu', 'mem'] as const).filter((r) => r !== b && (cells[r].usedPct ?? 100) < 50);
  const freeText = free.length
    ? ` ${capital(free.map((r) => (r === 'cpu' ? 'процессор' : 'память')).join(' и '))} почти свободн${free.length > 1 ? 'ы' : r1(free[0])}.`
    : '';
  if (b === 'net')
    return `Упрётся в канал${link.source === 'none' ? '' : ` (${formatMbit(link.upMbit)})`}.${freeText} Помогут канал больше или перенос части людей на другие ноды.`;
  if (b === 'cpu') return `Упрётся в процессор.${freeText} Помогут больше ядер или перенос части людей.`;
  if (b === 'mem') return `Упрётся в память.${freeText} Помогут больше памяти или перенос части людей.`;
  return 'Упрётся в предел соединений ядра — его можно поднять (nf_conntrack_max), это дёшево.';
}
const r1 = (r: 'cpu' | 'mem' | undefined) => (r === 'cpu' ? '' : 'а');
const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** Тон по запасу относительно нынешнего пика. */
export function toneOf(left: number | null, peak: number | null): 'ok' | 'warn' | 'crit' | 'mute' {
  if (left == null || peak == null || peak === 0) return 'mute';
  const share = left / peak;
  return share < 0.15 ? 'crit' : share < 0.5 ? 'warn' : 'ok';
}

/** Рост пика онлайна за неделю, % (последние 7 дней против предыдущих 7). */
export function weeklyGrowthPct(t: number[], online: Array<number | null>, endSec: number): number | null {
  const week = 7 * 86_400;
  let cur = 0;
  let prev = 0;
  for (let i = 0; i < t.length; i += 1) {
    const v = online[i];
    if (v == null) continue;
    const at = t[i] as number;
    if (at > endSec - week) cur = Math.max(cur, v);
    else if (at > endSec - 2 * week) prev = Math.max(prev, v);
  }
  if (prev < CAPACITY_MIN_ONLINE || cur === 0) return null;
  return round1(((cur - prev) / prev) * 100);
}

/** Через сколько дней кончится запас при таком росте (сложный процент по неделям); null — не растёт. */
export function daysUntilFull(left: number, peak: number, growthPctWeek: number | null): number | null {
  if (growthPctWeek == null || growthPctWeek <= 0 || peak <= 0) return null;
  const weeks = Math.log(1 + left / peak) / Math.log(1 + growthPctWeek / 100);
  return Number.isFinite(weeks) ? Math.max(0, Math.round(weeks * 7)) : null;
}
