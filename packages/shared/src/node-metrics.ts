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
/**
 * Весь парк в одной корзине (считает сервер): онлайн и трафик — сумма по нодам, приславшим замер; память,
 * нагрузка и процессор — среднее по ним же. Выключенная нода даёт ноль в сумме и не входит в среднее.
 */
export const fleetMetricPointSchema = z.object({
  t: z.number(),
  online: z.number().nullable(),
  rx: z.number().nullable(),
  tx: z.number().nullable(),
  ram: z.number().nullable(),
  load: z.number().nullable(),
  cpu: z.number().nullable(),
  /** Сколько нод было на связи. */
  up: z.number().nullable(),
  /** Сколько нод прислали замер; 0 — в корзине нет данных. */
  nodes: z.number().int().nonnegative(),
});
export const nodeMetricsSchema = z.object({
  panel: z.string().nullable(),
  /** Шаг корзин, секунды. */
  bucketSeconds: z.number().positive(),
  history: z.array(z.object({ uuid: z.string(), points: z.array(nodeMetricPointSchema) })),
  fleet: z.array(fleetMetricPointSchema),
  /** Обычный онлайн парка в этот час: 10-й и 90-й процентили за 7 дней; null — истории меньше трёх дней. */
  onlineTypical: z.object({ low: z.number(), high: z.number() }).nullable(),
  collectedSince: z.string().nullable(),
});
export type NodeMetricPoint = z.infer<typeof nodeMetricPointSchema>;
export type FleetMetricPoint = z.infer<typeof fleetMetricPointSchema>;
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
