import type { MonitoringSettings, RemnawaveNode } from '@nodeservice/shared';
export type Sample = { at: number; online: number };
export function stableBaseline(samples: Sample[], now: number, cfg: MonitoringSettings): number | null {
  if (!samples.length || now - (samples.at(-1)?.at ?? 0) > cfg.staleAfterMinutes * 60000) return null;
  const recent = samples.filter((s) => s.at >= now - cfg.dropWindowMinutes * 60000);
  if (recent.length < 3) return null;
  return [...recent].sort((a, b) => b.online - a.online)[2]?.online ?? null;
}
export function memoryPercent(node: RemnawaveNode): number | null {
  const used = node.memoryUsedBytes,
    total = node.memoryTotalBytes;
  return typeof used === 'number' && typeof total === 'number' && total > 0 && used >= 0
    ? Math.min(100, (used / total) * 100)
    : null;
}
export function dropDetected(online: number, baseline: number | null, cfg: MonitoringSettings): boolean {
  return (
    baseline !== null &&
    baseline >= cfg.minOnline &&
    ((baseline - online) / baseline) * 100 >= cfg.dropPercent
  );
}
/**
 * Нагрузка на одно ядро: средняя за 15 минут (нет — за 5 или за минуту), делённая на число ядер. Процента
 * процессора Remnawave не отдаёт; 1,0 — ядро занято полностью. Нет данных — null.
 */
export function loadPerCore(node: RemnawaveNode): number | null {
  const avg = node.loadAverage?.[2] ?? node.loadAverage?.[1] ?? node.loadAverage?.[0] ?? null;
  return typeof avg === 'number' && node.cpuCount ? avg / node.cpuCount : null;
}
/** «1,5» — нагрузка на ядро с одним знаком после запятой. */
export const perCoreText = (v: number): string =>
  v.toLocaleString('ru-RU', { maximumFractionDigits: 1, minimumFractionDigits: 1 });
