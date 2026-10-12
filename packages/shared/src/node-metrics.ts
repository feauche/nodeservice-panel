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

/** Bounded persisted history; time bounds are instants, not browser-local dates. */
const metricValuesSchema = nodeMetricPointSchema.omit({ t: true });
export const nodeMetricHistorySchema = z.object({
  panel: z.string().nullable(),
  from: z.string(),
  to: z.string(),
  bucketSeconds: z.number().positive(),
  collectedSince: z.string().nullable(),
  nodes: z.array(
    z.object({
      uuid: z.string(),
      name: z.string(),
      address: z.string(),
      points: z.array(nodeMetricPointSchema.extend({ min: metricValuesSchema, max: metricValuesSchema })),
    }),
  ),
  onlineSummary: z
    .object({
      peak: z.number().nullable(),
      peakAt: z.string().nullable(),
      average: z.number().nullable(),
      minimum: z.number().nullable(),
      samples: z.number().int().nonnegative(),
      partial: z.boolean(),
    })
    .optional(),
  events: z.array(
    z.object({
      id: z.string(),
      t: z.number(),
      nodeUuid: z.string(),
      nodeName: z.string(),
      type: z.enum([
        'incident_opened',
        'incident_resolved',
        'tcp_check',
        'dpi_check',
        'bs_check',
        'automation',
      ]),
      title: z.string(),
      summary: z.string(),
      link: z.string().nullable(),
    }),
  ),
  eventsTruncated: z.boolean(),
});
export type NodeMetricHistory = z.infer<typeof nodeMetricHistorySchema>;
