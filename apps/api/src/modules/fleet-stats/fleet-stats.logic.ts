/** Сколько секунд из [from, to) покрыто интервалами (пересечения считаются один раз). */
export function coveredSeconds(intervals: Array<[number, number]>, from: number, to: number): number {
  const clipped = intervals
    .map(([a, b]) => [Math.max(a, from), Math.min(b, to)] as [number, number])
    .filter(([a, b]) => b > a)
    .sort((x, y) => x[0] - y[0]);
  let total = 0;
  let curA = -1;
  let curB = -1;
  for (const [a, b] of clipped) {
    if (a > curB) {
      if (curB > curA) total += curB - curA;
      curA = a;
      curB = b;
    } else curB = Math.max(curB, b);
  }
  if (curB > curA) total += curB - curA;
  return total / 1000;
}

/** Максимум серии и когда он был. */
export function peakOf(points: Array<[number, number]>): { value: number; at: number } | null {
  let best: { value: number; at: number } | null = null;
  for (const [t, v] of points)
    if (Number.isFinite(v) && (!best || v > best.value)) best = { value: v, at: t };
  return best;
}

export function avgOf(values: number[]): number | null {
  const ok = values.filter((v) => Number.isFinite(v));
  return ok.length === 0 ? null : ok.reduce((a, b) => a + b, 0) / ok.length;
}

/** Округление для процентов: одна цифра после запятой. */
export const round1 = (v: number | null): number | null => (v === null ? null : Math.round(v * 10) / 10);
