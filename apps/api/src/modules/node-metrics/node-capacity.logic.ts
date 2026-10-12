import { CAPACITY_LIMITS, type CapacityResource, type NodeCapacityRow } from '@nodeservice/shared';

/** Ноду с меньшим пиком не считаем: при такой нагрузке запас не измерить. */
export const CAPACITY_MIN_USERS = 30;
/** Замеров в загруженные часы нужно хотя бы столько (корзины по 15 минут — это три часа). */
const MIN_BUSY_POINTS = 12;

export interface CapacityPoint {
  t: number;
  online: number | null;
  ram: number | null;
  load: number | null;
  rx: number | null;
  tx: number | null;
}

type Estimate = Pick<
  NodeCapacityRow,
  'peakOnline' | 'cpu' | 'ram' | 'channel' | 'extra' | 'bottleneck' | 'preliminary' | 'skipped' | 'days'
>;

const skipped = (
  reason: NonNullable<NodeCapacityRow['skipped']>,
  peak: number | null,
  days = 0,
): Estimate => ({
  peakOnline: peak,
  cpu: null,
  ram: null,
  channel: null,
  extra: null,
  bottleneck: null,
  preliminary: false,
  skipped: reason,
  days,
});

/**
 * Загрузка ресурса от онлайна: прямая y = a + b·x по замерам загруженных часов. a — то, что нода тратит без
 * пользователей, b — на каждого пользователя. Если загрузка с онлайном не растёт (b ≤ 0), считаем её
 * пропорциональной онлайну — это осторожнее: запас выходит меньше.
 */
function fitLine(pairs: Array<[number, number]>, peak: number) {
  const n = pairs.length;
  const mx = pairs.reduce((s, [x]) => s + x, 0) / n;
  const my = pairs.reduce((s, [, y]) => s + y, 0) / n;
  let sxy = 0;
  let sxx = 0;
  for (const [x, y] of pairs) {
    sxy += (x - mx) * (y - my);
    sxx += (x - mx) ** 2;
  }
  const b = sxx > 0 ? sxy / sxx : 0;
  const a = my - b * mx;
  if (b > 0 && a + b * peak > 0) return { atPeak: a + b * peak, users: (limit: number) => (limit - a) / b };
  // Пропорционально: загрузка в самые людные замеры, поделённая на их онлайн.
  const top = [...pairs].sort((p, q) => q[0] - p[0]).slice(0, Math.max(3, Math.ceil(n / 10)));
  const perUser = top.reduce((s, [x, y]) => s + y / x, 0) / top.length;
  return {
    atPeak: perUser * peak,
    users: (limit: number) => (perUser > 0 ? limit / perUser : Number.POSITIVE_INFINITY),
  };
}

/**
 * Запас ноды: сколько пользователей она выдержит сверх пика, пока процессор (нагрузка на ядро), память или
 * канал не дойдут до безопасного предела. Без лимита канала и при истории меньше трёх дней расчёт
 * предварительный.
 */
export function estimateCapacity(
  points: CapacityPoint[],
  node: { cores: number | null; channelMbps: number | null; disabled: boolean },
): Estimate {
  const online = points.filter((p): p is CapacityPoint & { online: number } => p.online != null);
  const peak = online.length ? Math.max(...online.map((p) => p.online)) : null;
  const shown = peak == null ? null : Math.round(peak);
  if (node.disabled) return skipped('disabled', shown);
  if (peak == null || peak < CAPACITY_MIN_USERS) return skipped('idle', shown);
  const busy = online.filter((p) => p.online >= Math.max(CAPACITY_MIN_USERS, peak * 0.3));
  const days = new Set(busy.map((p) => new Date(p.t).toISOString().slice(0, 10))).size;
  if (busy.length < MIN_BUSY_POINTS) return skipped('collecting', shown, days);

  const value: Record<CapacityResource, (p: CapacityPoint) => number | null> = {
    cpu: (p) => (node.cores && p.load != null ? (p.load / node.cores) * 100 : null),
    ram: (p) => p.ram,
    // Канал дуплексный: предел у каждого направления свой, поэтому берём большее из приёма и отдачи.
    channel: (p) =>
      node.channelMbps && p.rx != null && p.tx != null
        ? ((Math.max(p.rx, p.tx) * 8) / 1e6 / node.channelMbps) * 100
        : null,
  };
  const load: Partial<Record<CapacityResource, number>> = {};
  const users: Partial<Record<CapacityResource, number>> = {};
  for (const r of ['cpu', 'ram', 'channel'] as const) {
    const pairs = busy.flatMap((p): Array<[number, number]> => {
      const v = value[r](p);
      return v == null ? [] : [[p.online, v]];
    });
    if (pairs.length < MIN_BUSY_POINTS) continue;
    const f = fitLine(pairs, peak);
    load[r] = f.atPeak;
    users[r] = f.users(CAPACITY_LIMITS[r]);
  }
  const ranked = (Object.entries(users) as Array<[CapacityResource, number]>).sort((x, y) => x[1] - y[1]);
  const first = ranked[0];
  const round = (x: number | undefined) => (x == null ? null : Math.round(x * 10) / 10);
  return {
    peakOnline: Math.round(peak),
    cpu: round(load.cpu),
    ram: round(load.ram),
    channel: round(load.channel),
    // Округляем вниз до десятков: точнее эта оценка всё равно не бывает.
    extra:
      first && Number.isFinite(first[1]) ? Math.max(0, Math.floor((first[1] - peak) / 10 + 1e-6) * 10) : null,
    bottleneck: first && Number.isFinite(first[1]) ? first[0] : null,
    preliminary: load.channel == null || days < 3,
    skipped: null,
    days,
  };
}
