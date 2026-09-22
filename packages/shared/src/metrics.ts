import { z } from 'zod';

/** Метрики агентов из VictoriaMetrics: диапазоны графиков и формы ответов. */

export const METRIC_RANGES = {
  '1h': { seconds: 3_600, stepSeconds: 30 },
  '24h': { seconds: 86_400, stepSeconds: 300 },
  '7d': { seconds: 604_800, stepSeconds: 1_800 },
} as const;
export const metricRangeSchema = z.enum(['1h', '24h', '7d']);
export type MetricRange = z.infer<typeof metricRangeSchema>;

export const SERVER_METRIC_KEYS = [
  'cpuPct',
  'load1',
  'memUsedMb',
  'memTotalMb',
  'diskUsedMb',
  'diskTotalMb',
  'netRxBps',
  'netTxBps',
  'netRxPps',
  'netTxPps',
  'conntrackCount',
] as const;
export type ServerMetricKey = (typeof SERVER_METRIC_KEYS)[number];

/** Точка серии: unix-секунды и значение (null — данных не было). */
export const metricPointSchema = z.object({ t: z.number().int(), v: z.number().nullable() });
export type MetricPoint = z.infer<typeof metricPointSchema>;

export const serverMetricsResponseSchema = z.object({
  range: metricRangeSchema,
  stepSeconds: z.number().int(),
  /** false — VictoriaMetrics недоступна: серии пустые, и это не ошибка панели. */
  vmOk: z.boolean(),
  series: z.record(z.enum(SERVER_METRIC_KEYS), z.array(metricPointSchema)),
});
export type ServerMetricsResponse = z.infer<typeof serverMetricsResponseSchema>;

export const serverMetricsQuerySchema = z.object({
  range: metricRangeSchema.default('1h'),
});

/** Сводка для «Обзора»: последние значения + мини-серия CPU для спарклайна. */
export const overviewServerMetricsSchema = z.object({
  serverId: z.uuid(),
  cpuPct: z.number().nullable(),
  memPct: z.number().nullable(),
  diskPct: z.number().nullable(),
  netRxBps: z.number().nullable(),
  netTxBps: z.number().nullable(),
  uptimeSec: z.number().nullable(),
  /** CPU за последние ~15 минут (шаг 30 с) — для спарклайна. */
  cpuSpark: z.array(z.number().nullable()),
});
export type OverviewServerMetrics = z.infer<typeof overviewServerMetricsSchema>;

/** Серии по парку целиком — для спарклайнов KPI и графика «Трафик парка» (15 минут, шаг 30 с). */
export const overviewFleetSchema = z.object({
  cpuAvgSpark: z.array(z.number().nullable()),
  /** Приём и отдача по всему парку раздельно, байт/с (сумма по серверам). */
  trafficRxSpark: z.array(z.number().nullable()),
  trafficTxSpark: z.array(z.number().nullable()),
  conntrackSpark: z.array(z.number().nullable()),
});
export type OverviewFleet = z.infer<typeof overviewFleetSchema>;

export const overviewMetricsResponseSchema = z.object({
  vmOk: z.boolean(),
  servers: z.array(overviewServerMetricsSchema),
  fleet: overviewFleetSchema,
});
export type OverviewMetricsResponse = z.infer<typeof overviewMetricsResponseSchema>;

/** Имена метрик в VictoriaMetrics (пишет агент через VmWriterService). */
export const VM_METRIC_NAMES: Record<ServerMetricKey, string> = {
  cpuPct: 'nodeservice_cpu_pct',
  load1: 'nodeservice_load1',
  memUsedMb: 'nodeservice_mem_used_mb',
  memTotalMb: 'nodeservice_mem_total_mb',
  diskUsedMb: 'nodeservice_disk_used_mb',
  diskTotalMb: 'nodeservice_disk_total_mb',
  netRxBps: 'nodeservice_net_rx_bps',
  netTxBps: 'nodeservice_net_tx_bps',
  netRxPps: 'nodeservice_net_rx_pps',
  netTxPps: 'nodeservice_net_tx_pps',
  conntrackCount: 'nodeservice_conntrack_count',
};
