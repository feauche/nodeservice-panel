import { z } from 'zod';

/**
 * Статистика всего парка за период (витрина `fleet-stats-variants.html`, A1; переключатели — вариант 1
 * `stats-switch-variants.html`). Трафик и нагрузка — из VictoriaMetrics (хранится 90 дней), доступность и
 * инциденты — из базы, стоимость — из «Биллинга», онлайн на нодах — записывается панелью раз в минуту.
 */
export const FLEET_STATS_PERIODS = ['day', 'week', 'month', 'quarter'] as const;
export const fleetStatsPeriodSchema = z.enum(FLEET_STATS_PERIODS);
export type FleetStatsPeriod = z.infer<typeof fleetStatsPeriodSchema>;
export const FLEET_STATS_PERIOD_LABELS: Record<FleetStatsPeriod, string> = {
  day: 'Сутки',
  week: 'Неделя',
  month: '30 дней',
  quarter: '90 дней',
};
/** Длина периода, шаг графика скорости и ширина столбца трафика, секунды. */
export const FLEET_STATS_PERIOD_SPEC: Record<
  FleetStatsPeriod,
  { seconds: number; step: number; bucket: number }
> = {
  day: { seconds: 86_400, step: 600, bucket: 3_600 },
  week: { seconds: 604_800, step: 3_600, bucket: 86_400 },
  month: { seconds: 2_592_000, step: 10_800, bucket: 86_400 },
  quarter: { seconds: 7_776_000, step: 43_200, bucket: 86_400 },
};

const n = z.number().nullable();

export const fleetStatsSchema = z.object({
  period: fleetStatsPeriodSchema,
  from: z.string(),
  to: z.string(),
  /** Хранилище метрик ответило; false — трафик и нагрузка неизвестны. */
  vmOk: z.boolean(),
  traffic: z.object({
    rxBytes: n,
    txBytes: n,
    /** Всего за прошлый такой же период — для сравнения. */
    prevTotalBytes: n,
    /** Пик суммарной скорости парка (средняя за шаг графика), бит/с, и когда. */
    peakBps: n,
    peakAt: z.string().nullable(),
    avgBps: n,
    buckets: z.array(z.object({ at: z.string(), bytes: z.number() })),
    speed: z.array(z.object({ at: z.string(), rx: z.number(), tx: z.number() })),
  }),
  availability: z.object({
    /** Доля времени, когда серверы были на связи, %, по инцидентам «агент/SSH недоступен». */
    pct: n,
    incidents: z.number().int(),
    /** Среднее время до закрытия, минуты. */
    avgFixMin: n,
  }),
  cost: z.object({
    spentRubMinor: z.number().int(),
    perTbRubMinor: n,
    perUserRubMinor: n,
    users: n,
  }),
  load: z.object({
    cpu: z.object({ avg: n, peak: n, peakServer: z.string().nullable() }),
    mem: z.object({ avg: n, peak: n, peakServer: z.string().nullable() }),
    conntrack: z.object({ avg: n, peak: n }),
    disk: z.object({ avg: n, peak: n, peakServer: z.string().nullable(), growthPct: n }),
  }),
  incidentsByKind: z.array(
    z.object({ kind: z.string(), label: z.string(), count: z.number().int(), avgMin: n }),
  ),
  online: z.object({
    points: z.array(z.object({ at: z.string(), value: z.number() })),
    peak: n,
    peakAt: z.string().nullable(),
    avg: n,
  }),
  servers: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      trafficBytes: n,
      sharePct: n,
      cpuAvg: n,
      cpuPeak: n,
      memAvg: n,
      uptimePct: n,
    }),
  ),
});
export type FleetStats = z.infer<typeof fleetStatsSchema>;
export const fleetStatsQuerySchema = z.object({ period: fleetStatsPeriodSchema.default('month') });
