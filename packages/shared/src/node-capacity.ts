import { z } from 'zod';
import type { NodeMetricPoint } from './node-metrics.js';
export const nodeCapacitySchema = z.object({
  rows: z.array(
    z.object({
      uuid: z.string(),
      name: z.string(),
      online: z.number().nullable(),
      peakOnline: z.number().nullable(),
      samples: z.number(),
      days: z.number(),
      limits: z.array(z.object({ name: z.string(), users: z.number() })),
      capacity: z.number().nullable(),
      headroom: z.number().nullable(),
      bottleneck: z.string().nullable(),
      missing: z.array(z.string()),
      confidence: z.enum(['collecting', 'preliminary', 'ready']),
      available: z.boolean(),
    }),
  ),
  calculatedAt: z.string(),
});
export function estimateNodeCapacity(points: NodeMetricPoint[], channelMbps: number | null) {
  const valid = points.filter(
    (p): p is NodeMetricPoint & { online: number } => p.online != null && p.online >= 30,
  );
  const days = new Set(valid.map((p) => new Date(p.t).toISOString().slice(0, 10))).size;
  const limits: { name: string; users: number }[] = [];
  const missing: string[] = [];
  const resource = (name: string, threshold: number, value: (p: NodeMetricPoint) => number | null) => {
    const estimates = valid
      .flatMap((p) => {
        const v = value(p);
        return v != null && v > 0 ? [(threshold / v) * p.online] : [];
      })
      .sort((a, b) => a - b);
    // Lower 10th percentile of paired estimates: sustained busy periods dominate.
    if (estimates.length >= 10)
      limits.push({
        name,
        users: Math.max(0, Math.floor(estimates[Math.floor((estimates.length - 1) * 0.1)] ?? 0)),
      });
    else missing.push(name);
  };
  resource('CPU', 80, (p) => p.cpu);
  resource('RAM', 85, (p) => p.ram);
  if (channelMbps)
    resource('Канал', ((channelMbps * 1e6) / 8) * 0.9, (p) =>
      p.rx != null && p.tx != null ? Math.max(p.rx, p.tx) : null,
    );
  else missing.push('Лимит канала');
  limits.sort((a, b) => a.users - b.users);
  const capacity = !missing.length && limits.length === 3 ? limits[0]?.users : null;
  return {
    samples: valid.length,
    days,
    limits,
    capacity,
    bottleneck: limits[0]?.name ?? null,
    missing,
    confidence:
      valid.length < 10 ? ('collecting' as const) : days < 3 ? ('preliminary' as const) : ('ready' as const),
    peakOnline: valid.length ? Math.max(...valid.map((p) => p.online)) : null,
  };
}
