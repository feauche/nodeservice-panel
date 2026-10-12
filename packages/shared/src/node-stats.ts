import { z } from 'zod';

/** Периоды вкладки «Статистика», дни. Замеры панель хранит 30 дней. */
export const NODE_STATS_DAYS = [1, 7, 30] as const;

/** Отчёт за период: трафик, онлайн, часы пика, сбои и ноды. */
export const nodeStatsSchema = z.object({
  panel: z.string().nullable(),
  days: z.number().int().positive(),
  from: z.string(),
  to: z.string(),
  /** Пояс панели: часы пика и подписи дат — по нему. */
  timeZone: z.string(),
  collectedSince: z.string().nullable(),
  traffic: z.object({
    /** Всего за период, байт (по данным Remnawave). */
    total: z.number().nullable(),
    /** По дням: всего — Remnawave; приём и отдача — его доля по замерам панели, null — замеров в тот день нет. */
    days: z.array(
      z.object({ date: z.string(), total: z.number(), rx: z.number().nullable(), tx: z.number().nullable() }),
    ),
    error: z.string().nullable(),
  }),
  online: z.object({
    peak: z.number().nullable(),
    peakAt: z.string().nullable(),
    average: z.number().nullable(),
    minimum: z.number().nullable(),
    bucketSeconds: z.number().positive(),
    /** Средний онлайн парка по корзинам; одиночный пропуск дорисован, null — нет данных. */
    series: z.array(z.object({ t: z.number(), v: z.number().nullable() })),
  }),
  heatmap: z.object({
    /** 7 строк (пн–вс) × 24 часа по поясу панели: средний онлайн; null — замеров в этот час не было. */
    cells: z.array(z.array(z.number().nullable())),
    /** По скольким дням истории посчитано (до 28). */
    days: z.number().int().nonnegative(),
    /** Четыре часа подряд с самым высоким и самым низким средним онлайном: час начала и час конца. */
    peak: z.object({ from: z.number().int(), to: z.number().int() }).nullable(),
    quiet: z.object({ from: z.number().int(), to: z.number().int() }).nullable(),
  }),
  incidents: z.object({
    /** Событий, открытых за период. */
    count: z.number().int().nonnegative(),
    /** Суммарная длительность событий в пределах периода по всем нодам, мс. */
    downtimeMs: z.number().nonnegative(),
  }),
  nodes: z.array(
    z.object({
      uuid: z.string(),
      name: z.string(),
      countryCode: z.string().nullable(),
      disabled: z.boolean(),
      traffic: z.number().nullable(),
      /** Доля в трафике парка, %. */
      share: z.number().nullable(),
      peakOnline: z.number().nullable(),
      /** Время на связи, % от замеров периода. */
      uptime: z.number().nullable(),
      incidents: z.number().int().nonnegative(),
    }),
  ),
});
export type NodeStats = z.infer<typeof nodeStatsSchema>;
