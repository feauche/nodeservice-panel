import { z } from 'zod';

/**
 * Обслуживание ноды (0.106.0): владелец предупреждает панель, что работает с нодой. Пока идёт — по ноде не
 * заводятся события и не идут сообщения, сценарии, автозамена DNS и плановые проверки её пропускают.
 */

/** Сроки на выбор: 30 минут, 1 час, 3 часа; `null` — до выключения кнопкой. */
export const NODE_MAINTENANCE_MINUTES = [30, 60, 180] as const;
/** «+1 час» в карточке ноды. */
export const NODE_MAINTENANCE_EXTEND_MINUTES = 60;
export const NODE_MAINTENANCE_REASON_MAX = 200;

export const nodeMaintenanceStartSchema = z.object({
  minutes: z.union([z.literal(30), z.literal(60), z.literal(180), z.null()]),
  reason: z
    .string()
    .trim()
    .max(NODE_MAINTENANCE_REASON_MAX, `Причина — не длиннее ${NODE_MAINTENANCE_REASON_MAX} знаков`)
    .default(''),
  hideHosts: z.boolean().default(false),
});
export type NodeMaintenanceStart = z.infer<typeof nodeMaintenanceStartSchema>;

/** Что вышло со скрытием Host при включении: имена скрытых, сколько общих пропущено, ошибка словами. */
export const nodeMaintenanceHostsSchema = z.object({
  hidden: z.array(z.string()).default([]),
  shared: z.number().int().nonnegative().default(0),
  error: z.string().nullable().default(null),
});
export type NodeMaintenanceHosts = z.infer<typeof nodeMaintenanceHostsSchema>;

export const nodeMaintenanceSchema = z.object({
  nodeUuid: z.string().min(1),
  nodeName: z.string(),
  startedAt: z.string(),
  /** Когда закончится само; `null` — до выключения кнопкой. */
  until: z.string().nullable(),
  reason: z.string().default(''),
  hideHosts: z.boolean().default(false),
  hosts: nodeMaintenanceHostsSchema.nullable().default(null),
});
export type NodeMaintenance = z.infer<typeof nodeMaintenanceSchema>;

/** Идёт ли обслуживание сейчас: без срока — пока не выключат, со сроком — до него. */
export function maintenanceActive(m: Pick<NodeMaintenance, 'until'>, now = Date.now()): boolean {
  return m.until === null || Date.parse(m.until) > now;
}

/** Host, которые скроются при включении обслуживания, — для окна включения. */
export const nodeMaintenanceHostPreviewSchema = z.object({
  hosts: z.array(
    z.object({ uuid: z.string(), name: z.string(), address: z.string(), port: z.number().nullable() }),
  ),
  /** Общих Host нескольких нод: их обслуживание не трогает. */
  shared: z.number().int().nonnegative(),
  /** Host уже скрыты (вручную или сценарием) — трогать нечего. */
  alreadyHidden: z.number().int().nonnegative(),
});
export type NodeMaintenanceHostPreview = z.infer<typeof nodeMaintenanceHostPreviewSchema>;

/** Итог «Закончить обслуживание»: какие Host вернулись и какие нет (словами). */
export const nodeMaintenanceEndSchema = z.object({
  ended: nodeMaintenanceSchema,
  restored: z.array(z.string()),
  failed: z.array(z.string()),
});
export type NodeMaintenanceEnd = z.infer<typeof nodeMaintenanceEndSchema>;
