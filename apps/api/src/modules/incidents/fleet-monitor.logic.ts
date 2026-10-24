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
/**
 * Загрузка канала ноды: больший из входящего и исходящего трафика в процентах от «Лимита канала». Лимит не задан,
 * нода не на связи или Remnawave не прислала скорость — null (не ноль и не перегрузка).
 */
export function channelLoad(
  node: RemnawaveNode,
  limitMbps: number | null | undefined,
): { percent: number; mbps: number; direction: 'входящий' | 'исходящий' } | null {
  const rx = node.rxBytesPerSec,
    tx = node.txBytesPerSec;
  if (!limitMbps || limitMbps <= 0 || !node.isConnected) return null;
  if (typeof rx !== 'number' && typeof tx !== 'number') return null;
  const inbound = typeof rx === 'number' && rx > 0 ? rx : 0,
    outbound = typeof tx === 'number' && tx > 0 ? tx : 0;
  const mbps = (Math.max(inbound, outbound) * 8) / 1_000_000;
  return {
    percent: (mbps / limitMbps) * 100,
    mbps,
    direction: outbound >= inbound ? 'исходящий' : 'входящий',
  };
}
export function dropDetected(online: number, baseline: number | null, cfg: MonitoringSettings): boolean {
  return (
    baseline !== null &&
    baseline >= cfg.minOnline &&
    ((baseline - online) / baseline) * 100 >= cfg.dropPercent
  );
}
/**
 * Нагрузка на одно ядро: средняя за минуту (нет — за 5 или 15 минут), делённая на число ядер, — то же число, что
 * в строке и окне ноды. Процента процессора Remnawave не отдаёт; 1,0 — ядро занято полностью. Нет данных — null.
 */
export function loadPerCore(node: RemnawaveNode): number | null {
  const avg = node.loadAverage?.[0] ?? node.loadAverage?.[1] ?? node.loadAverage?.[2] ?? null;
  return typeof avg === 'number' && node.cpuCount ? avg / node.cpuCount : null;
}
/** «1,5» — нагрузка на ядро с одним знаком после запятой. */
export const perCoreText = (v: number): string =>
  v.toLocaleString('ru-RU', { maximumFractionDigits: 1, minimumFractionDigits: 1 });
