import { z } from 'zod';

/** Безопасные пределы: дальше нода начинает тормозить. Процессор — нагрузка на ядро (1,0 на ядро = 100 %). */
export const CAPACITY_LIMITS = { cpu: 80, ram: 85, channel: 90 } as const;
/** История, по которой считается запас, дни. */
export const CAPACITY_DAYS = 14;
export const CAPACITY_RESOURCES = ['cpu', 'ram', 'channel'] as const;
export type CapacityResource = (typeof CAPACITY_RESOURCES)[number];

export const nodeCapacityRowSchema = z.object({
  uuid: z.string(),
  name: z.string(),
  countryCode: z.string().nullable(),
  cores: z.number().nullable(),
  /** Пик онлайна за период. */
  peakOnline: z.number().nullable(),
  /** Загрузка в пик, %: процессор — нагрузка на ядро, память, канал — от указанного лимита. */
  cpu: z.number().nullable(),
  ram: z.number().nullable(),
  channel: z.number().nullable(),
  /** Лимит канала из настроек ноды, Мбит/с; null — не указан. */
  channelMbps: z.number().nullable(),
  /** Сколько ещё пользователей выдержит сверх пика; null — не рассчитано. */
  extra: z.number().nullable(),
  /** Что кончится первым. */
  bottleneck: z.enum(CAPACITY_RESOURCES).nullable(),
  /** Расчёт без лимита канала или по истории меньше трёх дней. */
  preliminary: z.boolean(),
  /** Почему не рассчитано: нода выключена, нагрузки мало, замеров мало. */
  skipped: z.enum(['disabled', 'idle', 'collecting']).nullable(),
  /** Дней истории с нагрузкой. */
  days: z.number().int().nonnegative(),
});
export const nodeCapacitySchema = z.object({
  rows: z.array(nodeCapacityRowSchema),
  calculatedAt: z.string(),
});
export type NodeCapacityRow = z.infer<typeof nodeCapacityRowSchema>;
export type NodeCapacity = z.infer<typeof nodeCapacitySchema>;
