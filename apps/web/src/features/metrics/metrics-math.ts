import type { NodeMetricHistory } from '@nodeservice/shared';

export type Metric = 'online' | 'load' | 'ram' | 'rx' | 'tx';
export type HistoryNode = NodeMetricHistory['nodes'][number];
export type HistoryEvent = NodeMetricHistory['events'][number];

export const METRICS: Record<Metric, { label: string; title: string; unit: string; sum: boolean }> = {
  online: { label: 'Онлайн', title: 'Онлайн', unit: '', sum: true },
  load: { label: 'Нагрузка', title: 'Нагрузка на ядро', unit: ' %', sum: false },
  ram: { label: 'Память', title: 'Память', unit: ' %', sum: false },
  rx: { label: 'Приём', title: 'Приём', unit: ' Мбит/с', sum: true },
  tx: { label: 'Отдача', title: 'Отдача', unit: ' Мбит/с', sum: true },
};

/** Цвет ноды: равномерно по кругу оттенков (золотой угол), у ноды он постоянный — по порядку её идентификатора. */
export const nodeColor = (index: number) => `hsl(${Math.round((index * 137.5 + 200) % 360)} 70% 62%)`;

/**
 * Значение точки в единицах графика: трафик — Мбит/с, нагрузка — процент на ядро (1,0 на ядро — 100 %),
 * память и онлайн — как есть.
 */
export function pointValue(
  p: HistoryNode['points'][number],
  metric: Metric,
  cores: number | null,
): number | null {
  if (metric === 'load') return p.load == null || !cores ? null : (p.load / cores) * 100;
  if (metric === 'rx' || metric === 'tx') {
    const v = p[metric];
    return v == null ? null : (v * 8) / 1e6;
  }
  return p[metric];
}

/** Ряды по нодам и «весь парк»: онлайн и трафик — сумма по приславшим, нагрузка и память — среднее по ним. */
export function buildRows(nodes: HistoryNode[], metric: Metric, cores: Map<string, number | null>) {
  const byT = new Map<number, Record<string, number | null>>();
  for (const node of nodes)
    for (const p of node.points) {
      const row = byT.get(p.t) ?? { t: p.t };
      row[node.uuid] = pointValue(p, metric, cores.get(node.uuid) ?? null);
      byT.set(p.t, row);
    }
  const rows = [...byT.values()].sort((a, b) => Number(a.t) - Number(b.t));
  for (const row of rows) {
    const vs = nodes.map((n) => row[n.uuid]).filter((v): v is number => v != null);
    row.fleet =
      vs.length === 0
        ? null
        : METRICS[metric].sum
          ? vs.reduce((s, v) => s + v, 0)
          : vs.reduce((s, v) => s + v, 0) / vs.length;
  }
  return rows;
}

/** Сейчас, пик и минимум ряда в видимом окне. */
export function seriesStats(rows: Array<Record<string, number | null>>, key: string) {
  let now: number | null = null;
  let peak: { v: number; t: number } | null = null;
  let min: { v: number; t: number } | null = null;
  let sum = 0;
  let n = 0;
  for (const row of rows) {
    const v = row[key];
    if (v == null) continue;
    const t = Number(row.t);
    now = v;
    if (!peak || v > peak.v) peak = { v, t };
    if (!min || v < min.v) min = { v, t };
    sum += v;
    n += 1;
  }
  return { now, peak, min, avg: n ? sum / n : null };
}

/** Близкие события (ближе двух шагов графика) сливаются в одну метку: так значки не налезают друг на друга. */
export function groupEvents(events: HistoryEvent[], gapMs: number) {
  const sorted = [...events].sort((a, b) => a.t - b.t);
  const groups: HistoryEvent[][] = [];
  for (const e of sorted) {
    const last = groups.at(-1);
    const tail = last?.at(-1);
    if (last && tail && e.t - tail.t <= gapMs) last.push(e);
    else groups.push([e]);
  }
  return groups;
}

export const eventTone = (e: HistoryEvent) =>
  e.type === 'incident_opened' ? 'crit' : e.type === 'incident_resolved' ? 'ok' : 'info';
