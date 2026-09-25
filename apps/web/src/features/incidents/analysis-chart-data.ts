import type { Incident, MetricRange, ServerMetricsResponse } from '@nodeservice/shared';

export type ChartMetric = 'cpuPct' | 'memPct' | 'diskPct';
export interface ChartPoint {
  t: number;
  v: number;
}

/** Окно графика: у свежего инцидента час, у старого сутки, чтобы момент открытия был в кадре. */
export function chartRange(openedAt: string, now: number): MetricRange {
  return now - Date.parse(openedAt) < 40 * 60_000 ? '1h' : '24h';
}

/** Ряд в процентах: CPU как есть, память и диск — доля занятого от общего, точки без данных пропускаются. */
export function pctSeries(metric: ChartMetric, series: ServerMetricsResponse['series']): ChartPoint[] {
  const ok = (v: number | null | undefined): v is number => typeof v === 'number' && Number.isFinite(v);
  if (metric === 'cpuPct') return (series.cpuPct ?? []).flatMap((p) => (ok(p.v) ? [{ t: p.t, v: p.v }] : []));
  const used = series[metric === 'memPct' ? 'memUsedMb' : 'diskUsedMb'] ?? [];
  const total = new Map(
    (series[metric === 'memPct' ? 'memTotalMb' : 'diskTotalMb'] ?? []).map((p) => [p.t, p.v]),
  );
  return used.flatMap((p) => {
    const tot = total.get(p.t);
    return ok(p.v) && ok(tot) && tot > 0 ? [{ t: p.t, v: (p.v / tot) * 100 }] : [];
  });
}

export const CHART_W = 100;
export const CHART_H = 40;

export interface ChartGeometry {
  line: string;
  area: string;
  yMin: number;
  yMax: number;
  /** Положение порога по вертикали, 0–100 % от высоты сверху; null — порога нет или он вне кадра. */
  thresholdTop: number | null;
  /** Доля времени по горизонтали, 0–100, для отметки; null — вне окна. */
  xOf: (t: number) => number | null;
}

/** Геометрия графика в условных единицах SVG; шкала подгоняется под данные и порог. */
export function buildGeometry(points: ChartPoint[], threshold: number | null): ChartGeometry | null {
  if (points.length < 2) return null;
  const from = points[0]?.t as number;
  const to = points.at(-1)?.t as number;
  if (to <= from) return null;
  const vals = points.map((p) => p.v);
  const lo = Math.min(...vals, threshold ?? Number.POSITIVE_INFINITY);
  const hi = Math.max(...vals, threshold ?? Number.NEGATIVE_INFINITY);
  let yMin = Math.max(0, Math.floor(lo - 5));
  let yMax = Math.min(100, Math.ceil(hi + 5));
  if (yMax - yMin < 10) {
    yMin = Math.max(0, yMax - 10);
    yMax = yMin + 10;
  }
  const x = (t: number) => ((t - from) / (to - from)) * CHART_W;
  const y = (v: number) => CHART_H - ((v - yMin) / (yMax - yMin)) * CHART_H;
  const f = (n: number) => Math.round(n * 100) / 100;
  const pts = points.map((p) => `${f(x(p.t))},${f(y(p.v))}`);
  const line = `M${pts.join(' L')}`;
  return {
    line,
    area: `${line} L${CHART_W},${CHART_H} L0,${CHART_H}Z`,
    yMin,
    yMax,
    thresholdTop:
      threshold !== null && threshold >= yMin && threshold <= yMax
        ? f(((CHART_H - ((threshold - yMin) / (yMax - yMin)) * CHART_H) / CHART_H) * 100)
        : null,
    xOf: (t) => (t < from || t > to ? null : f((x(t) / CHART_W) * 100)),
  };
}

export interface ChartMarker {
  key: string;
  label: string;
  title: string;
  kind: 'open' | 'attempt';
  /** Настоящее положение, %: по нему рисуется линия. */
  x: number;
  /** Положение значка, %: разведено, чтобы значки не налезали друг на друга. */
  shown: number;
}

/** Разводит значки по горизонтали: минимум `gap` процентов между соседними, справа упираемся в край. */
export function spreadMarkers<T extends { x: number }>(
  items: T[],
  gap = 4.5,
  max = 97,
): Array<T & { shown: number }> {
  const sorted = [...items].sort((a, b) => a.x - b.x);
  const out = sorted.map((m) => ({ ...m, shown: Math.max(3, m.x) }));
  for (let i = 1; i < out.length; i += 1) {
    const prev = out[i - 1] as { shown: number };
    const cur = out[i] as { shown: number };
    if (cur.shown < prev.shown + gap) cur.shown = prev.shown + gap;
  }
  for (let i = out.length - 1; i >= 0; i -= 1) {
    const cur = out[i] as { shown: number };
    const limit = i === out.length - 1 ? max : (out[i + 1] as { shown: number }).shown - gap;
    if (cur.shown > limit) cur.shown = limit;
  }
  return out;
}

/** Отметки на графике: открытие и попытки починки, которые попали в окно. */
export function chartMarkers(
  inc: Pick<Incident, 'openedAt' | 'attempts'>,
  xOf: ChartGeometry['xOf'],
  actionTitle: (key: string) => string,
): ChartMarker[] {
  const list: Array<Omit<ChartMarker, 'shown'>> = [];
  const open = xOf(Date.parse(inc.openedAt) / 1000);
  if (open !== null) list.push({ key: 'open', label: '!', title: 'Инцидент открыт', kind: 'open', x: open });
  inc.attempts.forEach((a, i) => {
    const x = xOf(Date.parse(a.startedAt) / 1000);
    if (x !== null)
      list.push({ key: a.id, label: String(i + 1), title: actionTitle(a.action), kind: 'attempt', x });
  });
  return spreadMarkers(list);
}
