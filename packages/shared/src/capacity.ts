import { z } from 'zod';

/**
 * Ёмкость парка (витрина `capacity-variants.html`, A1: вкладка «Ёмкость» в «Обзоре», таблица с полосами).
 * Сколько ещё людей выдержит каждая нода и во что она упрётся первой: процессор, память, канал, соединения.
 * Считается по пикам за 14 дней: онлайн нод из Remnawave и в те же минуты нагрузка из метрик агента.
 */
export const CAPACITY_RESOURCES = ['cpu', 'mem', 'net', 'conn'] as const;
export type CapacityResource = (typeof CAPACITY_RESOURCES)[number];
export const CAPACITY_RESOURCE_LABELS: Record<CapacityResource, string> = {
  cpu: 'процессор',
  mem: 'память',
  net: 'канал',
  conn: 'соединения',
};
/** Безопасный потолок, % — не 100: у сервера должен оставаться запас на всплески. */
export const CAPACITY_LIMIT_PCT: Record<CapacityResource, number> = { cpu: 80, mem: 85, net: 90, conn: 80 };
/** Окно расчёта, дней; меньше MIN_DAYS данных или пик меньше MIN_ONLINE — «мало данных». */
export const CAPACITY_WINDOW_DAYS = 14;
export const CAPACITY_MIN_DAYS = 3;
export const CAPACITY_MIN_ONLINE = 30;

/** Откуда взята скорость канала. */
export const LINK_SOURCES = ['manual', 'measured', 'nic', 'none'] as const;
export type LinkSource = (typeof LINK_SOURCES)[number];
export const LINK_SOURCE_LABELS: Record<LinkSource, string> = {
  manual: 'указано вручную',
  measured: 'по замеру',
  nic: 'по сетевой карте',
  none: 'неизвестен',
};

const n = z.number().nullable();

export const serverLinkSchema = z.object({
  /** Сколько берём в расчёт, Мбит/с (загрузка и отдача); null — канал неизвестен. */
  downMbit: n,
  upMbit: n,
  source: z.enum(LINK_SOURCES),
  /** Сетевая карта: имя, скорость порта, виртуальная ли (у виртуальной скорость порта ничего не значит). */
  nicName: z.string().nullable(),
  nicMbit: n,
  nicVirtual: z.boolean().nullable(),
  /** Последний замер: свободная полоса + то, что уже шло в момент замера. */
  measuredDownMbit: n,
  measuredUpMbit: n,
  measuredAt: z.string().nullable(),
  manualMbit: n,
  /** Предел соединений ядра (nf_conntrack_max). */
  conntrackMax: n,
  probedAt: z.string().nullable(),
});
export type ServerLink = z.infer<typeof serverLinkSchema>;

export const capacityCellSchema = z.object({
  /** Загрузка в час пик, % от ресурса (для канала — от скорости канала). */
  usedPct: n,
  limitPct: z.number(),
  /** Сколько ещё человек выдержит нода по этому ресурсу; null — не ограничивает или неизвестно. */
  left: z.number().int().nullable(),
  /** Подпись под полосой: «890 из 1000 Мбит/с», «канал неизвестен». */
  detail: z.string().nullable(),
});
export type CapacityCell = z.infer<typeof capacityCellSchema>;

export const CAPACITY_STATUSES = ['ok', 'few_data', 'weak', 'no_online', 'no_metrics'] as const;
export type CapacityStatus = (typeof CAPACITY_STATUSES)[number];

export const capacityServerSchema = z.object({
  serverId: z.string(),
  name: z.string(),
  country: z.string().nullable(),
  /** exit — нода Remnawave; bridge — мост, онлайн берётся у выходов за ним; other — не нода. */
  role: z.enum(['exit', 'bridge', 'other']),
  status: z.enum(CAPACITY_STATUSES),
  onlinePeak: z.number().int().nullable(),
  peakAt: z.string().nullable(),
  left: z.number().int().nullable(),
  bottleneck: z.enum(CAPACITY_RESOURCES).nullable(),
  /** crit — запас почти кончился, warn — меньше половины от нынешнего пика, ok — хороший, mute — не считается. */
  tone: z.enum(['ok', 'warn', 'crit', 'mute']),
  cells: z.object({
    cpu: capacityCellSchema,
    mem: capacityCellSchema,
    net: capacityCellSchema,
    conn: capacityCellSchema,
  }),
  link: serverLinkSchema,
  /** Пояснение словами — почему такой вывод или почему не посчитано. */
  note: z.string().nullable(),
});
export type CapacityServer = z.infer<typeof capacityServerSchema>;

export const capacitySchema = z.object({
  computedAt: z.string(),
  vmOk: z.boolean(),
  remnawave: z.boolean(),
  /** Онлайн парка в пик за окно и когда. */
  onlinePeak: z.number().int().nullable(),
  peakAt: z.string().nullable(),
  left: z.number().int().nullable(),
  /** Во что чаще всего упираются ноды и у скольких. */
  bottleneck: z.enum(CAPACITY_RESOURCES).nullable(),
  bottleneckCount: z.number().int(),
  counted: z.number().int(),
  /** Рост пика онлайна за неделю, %; null — мало данных. */
  growthPctWeek: n,
  /** Через сколько дней первая нода упрётся при таком росте. */
  soonest: z.object({ days: z.number().int(), serverId: z.string(), name: z.string() }).nullable(),
  servers: z.array(capacityServerSchema),
});
export type Capacity = z.infer<typeof capacitySchema>;

export const serverLinkUpdateSchema = z.object({
  /** Скорость канала вручную, Мбит/с; null — убрать и считать автоматически. */
  manualMbit: z.number().int().min(10).max(400_000).nullable(),
});
export type ServerLinkUpdate = z.infer<typeof serverLinkUpdateSchema>;

/** «890 Мбит/с», «2,1 Гбит/с». */
export function formatMbit(mbit: number | null | undefined): string {
  if (mbit == null) return '—';
  if (mbit >= 1000) return `${(mbit / 1000).toLocaleString('ru-RU', { maximumFractionDigits: 1 })} Гбит/с`;
  return `${Math.round(mbit).toLocaleString('ru-RU')} Мбит/с`;
}
