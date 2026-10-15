import type { FleetMetricPoint, NodeMetricPoint } from '@nodeservice/shared';
import { sql } from 'drizzle-orm';

export const METRIC_FIELDS = ['cpu', 'ram', 'load', 'rx', 'tx', 'online'] as const;
type Field = (typeof METRIC_FIELDS)[number];
type Values = Record<Field, number | null>;

/**
 * Была ли нода на связи в замере. До 0.91.0 этого признака в замерах не было: тогда «на связи» — если нода
 * прислала память, нагрузку или хоть одного пользователя. Замер во время обслуживания ноды (0.106.0, `mt`) —
 * пусто: в среднем «на связи» и аптайме он не участвует, работы владельца аптайм не портят.
 */
export const UP_SQL = sql.raw(`CASE WHEN values ? 'mt' THEN NULL ELSE COALESCE((values->>'up')::float,
  CASE WHEN values->>'ram' IS NOT NULL OR values->>'load' IS NOT NULL OR COALESCE((values->>'online')::float, 0) > 0
  THEN 1 ELSE 0 END) END`);

/**
 * Скорость за корзину, байт в секунду: сумма байт за промежутки, делённая на сумму их длительности по часам ноды
 * (с 0.96.0 замер хранит разницу счётчиков). Замеры до 0.96.0 — секундный снимок скорости Remnawave: считаем его
 * минутой с этой скоростью, пока такие замеры не уйдут из 30-дневной истории. Замер без промежутка не участвует.
 */
export const rateSql = (dir: 'rx' | 'tx') =>
  sql.raw(`(sum(CASE WHEN values ? 'dt' THEN (values->>'${dir}Bytes')::float ELSE (values->>'${dir}')::float * 60 END)
    / nullif(sum(CASE WHEN values ? 'dt' THEN CASE WHEN values->>'${dir}Bytes' IS NOT NULL THEN (values->>'dt')::float END
      WHEN values->>'${dir}' IS NOT NULL THEN 60 END), 0))`);

/** Корзина без единого замера. У выключенной ноды онлайн 0, а не пусто: такая корзина не пустая. */
export const isMissing = (p: Values): boolean => METRIC_FIELDS.every((f) => p[f] == null);

/** Среднее двух соседей; если известен только один — его значение. */
export const mean2 = (a: number | null, b: number | null): number | null =>
  a != null && b != null ? (a + b) / 2 : (a ?? b);

/**
 * Одиночный пропуск замера (корзина пуста, обе соседние — нет) дорисовываем средним соседей. Так опрос, который
 * пришёл на пару секунд позже и попал в соседнюю минуту, не рвёт график. Настоящий перерыв — две пустые
 * корзины подряд и больше — остаётся пустым, и график показывает его как «нет данных».
 */
export function bridgeSingleGaps<P extends Values>(points: P[], fill: (prev: P, next: P, gap: P) => P): P[] {
  return points.map((p, i) => {
    const prev = points[i - 1];
    const next = points[i + 1];
    return prev && next && isMissing(p) && !isMissing(prev) && !isMissing(next) ? fill(prev, next, p) : p;
  });
}

/** Дорисовка для обычной точки: каждый показатель — среднее соседей. */
export const fillPoint = (
  prev: NodeMetricPoint,
  next: NodeMetricPoint,
  gap: NodeMetricPoint,
): NodeMetricPoint => ({
  ...gap,
  ...Object.fromEntries(METRIC_FIELDS.map((f) => [f, mean2(prev[f], next[f])])),
});

/**
 * Весь парк по корзинам: онлайн и трафик — сумма по нодам, приславшим замер; память, нагрузка и процессор —
 * среднее по ним же. Выключенная нода даёт ноль в сумме и не входит в среднее (её память и нагрузка пусты).
 * Нода, не приславшая замер, просто не участвует: сумма не гаснет целиком из-за одной ноды.
 * `up` — сколько нод было на связи (доля времени на связи в корзине не меньше половины).
 */
export function fleetSeries(
  history: Array<{ uuid: string; points: NodeMetricPoint[] }>,
  upByNode: Map<string, Map<number, number>>,
): FleetMetricPoint[] {
  const byNode = history.map((n) => ({ uuid: n.uuid, at: new Map(n.points.map((p) => [p.t, p])) }));
  const times = [...new Set(history.flatMap((n) => n.points.map((p) => p.t)))].sort((a, b) => a - b);
  return times.map((t) => {
    let nodes = 0;
    let up = 0;
    const sums = { online: [0, 0], rx: [0, 0], tx: [0, 0] } as Record<
      'online' | 'rx' | 'tx',
      [number, number]
    >;
    const means = { ram: [0, 0], load: [0, 0], cpu: [0, 0] } as Record<
      'ram' | 'load' | 'cpu',
      [number, number]
    >;
    for (const node of byNode) {
      const p = node.at.get(t);
      if (!p || isMissing(p)) continue;
      nodes += 1;
      if ((upByNode.get(node.uuid)?.get(t) ?? 0) >= 0.5) up += 1;
      for (const f of ['online', 'rx', 'tx'] as const) {
        const v = p[f];
        if (v != null) {
          sums[f][0] += v;
          sums[f][1] += 1;
        }
      }
      for (const f of ['ram', 'load', 'cpu'] as const) {
        const v = p[f];
        if (v != null) {
          means[f][0] += v;
          means[f][1] += 1;
        }
      }
    }
    const total = (f: keyof typeof sums) => (sums[f][1] ? sums[f][0] : null);
    const avg = (f: keyof typeof means) => (means[f][1] ? means[f][0] / means[f][1] : null);
    return nodes === 0
      ? { t, online: null, rx: null, tx: null, ram: null, load: null, cpu: null, up: null, nodes: 0 }
      : {
          t,
          online: total('online'),
          rx: total('rx'),
          tx: total('tx'),
          ram: avg('ram'),
          load: avg('load'),
          cpu: avg('cpu'),
          up,
          nodes,
        };
  });
}
