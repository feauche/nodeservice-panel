import { z } from 'zod';
export const nodeMetricPointSchema = z.object({
  t: z.number(),
  cpu: z.number().nullable(),
  ram: z.number().nullable(),
  load: z.number().nullable(),
  rx: z.number().nullable(),
  tx: z.number().nullable(),
  online: z.number().nullable(),
});
export const remnaTrafficSchema = z.object({
  categories: z.array(z.string()),
  sparklineData: z.array(z.number()),
  series: z.array(
    z.object({ uuid: z.string(), name: z.string(), total: z.number(), data: z.array(z.number()) }),
  ),
});
export const nodeMetricsSchema = z.object({
  panel: z.string().nullable(),
  history: z.array(z.object({ uuid: z.string(), points: z.array(nodeMetricPointSchema) })),
  traffic: remnaTrafficSchema.nullable(),
  trafficError: z.string().nullable(),
  collectedSince: z.string().nullable(),
});
export type NodeMetricPoint = z.infer<typeof nodeMetricPointSchema>;
export type NodeMetrics = z.infer<typeof nodeMetricsSchema>;
