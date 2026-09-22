import { z } from 'zod';

/**
 * Обслуживание сервера (R1.8). Панель заходит по SSH (тем же ключом, что ставит агента и
 * открывает терминал) и раз в сутки собирает чек-лист: обновления, перезагрузка, версия агента,
 * диск, автообновления. Действия из чек-листа выполняются по шагам с живым логом.
 *
 *  GET  /api/servers/:id/maintenance            → MaintenanceState
 *  POST /api/servers/:id/maintenance/runs       { kind } → 202 MaintenanceRun (409, если что-то уже идёт)
 *  GET  /api/servers/:id/maintenance/runs       → { items: MaintenanceRun[] } (свежие первыми, без лога)
 *
 * Уровни действий (см. мастер-план, безопасность T0–T3):
 *  T0 — только чтение (проверка), T1 — панель может сама (обратимо, с проверкой после),
 *  T2 — с подтверждением администратора, T3 — только вручную в терминале (перезагрузка).
 */

export const MAINTENANCE_KINDS = [
  'check',
  'apt_upgrade',
  'agent_update',
  'cleanup',
  'unattended_enable',
] as const;
export type MaintenanceKind = (typeof MAINTENANCE_KINDS)[number];

export type MaintenanceTier = 'T0' | 'T1' | 'T2' | 'T3';

export const MAINTENANCE_TIERS: Record<MaintenanceKind, MaintenanceTier> = {
  check: 'T0',
  agent_update: 'T1',
  apt_upgrade: 'T2',
  cleanup: 'T2',
  unattended_enable: 'T2',
};

export const MAINTENANCE_KIND_LABELS: Record<MaintenanceKind, string> = {
  check: 'Проверка сервера',
  apt_upgrade: 'Обновление системы',
  agent_update: 'Обновление агента',
  cleanup: 'Очистка диска',
  unattended_enable: 'Автообновления безопасности',
};

export const MAINTENANCE_TIER_LABELS: Record<MaintenanceTier, string> = {
  T0: 'только чтение',
  T1: 'панель делает сама',
  T2: 'с вашим подтверждением',
  T3: 'только вручную',
};

/** Раз в сколько часов панель сама перепроверяет сервер. */
export const MAINTENANCE_CHECK_INTERVAL_HOURS = 24;
/** Сколько лога хранить на один запуск (символов). */
export const MAINTENANCE_LOG_MAX = 200_000;
export const MAINTENANCE_RUNS_LIMIT = 50;

export const MAINTENANCE_PROBLEM = {
  busy: 'urn:nodeservice:problem:maintenance-busy',
  unsupported: 'urn:nodeservice:problem:maintenance-unsupported',
} as const;

/** Результат проверки — то, из чего собирается чек-лист. `null` — узнать не удалось. */
export const maintenanceCheckSchema = z.object({
  checkedAt: z.iso.datetime({ offset: true }),
  /** Есть apt: Debian/Ubuntu. Иначе обновления и очистка недоступны, остальное показываем. */
  supported: z.boolean(),
  updates: z.object({ total: z.number().int().min(0), security: z.number().int().min(0) }).nullable(),
  rebootRequired: z.boolean().nullable(),
  kernel: z.object({ running: z.string().nullable(), installed: z.string().nullable() }),
  unattended: z.boolean().nullable(),
  agent: z.object({
    installed: z.string().nullable(),
    latest: z.string().nullable(),
    service: z.string().nullable(),
  }),
  disk: z.object({
    usedPct: z.number().min(0).max(100).nullable(),
    freeMb: z.number().int().min(0).nullable(),
  }),
  /** Что не удалось узнать и почему — коротко, для подсказки в строке. */
  warnings: z.array(z.string()),
});
export type MaintenanceCheck = z.infer<typeof maintenanceCheckSchema>;

export const MAINTENANCE_STEP_STATUSES = ['pending', 'running', 'ok', 'failed', 'skipped'] as const;
export const maintenanceStepSchema = z.object({
  key: z.string(),
  label: z.string(),
  status: z.enum(MAINTENANCE_STEP_STATUSES),
  startedAt: z.iso.datetime({ offset: true }).nullable(),
  finishedAt: z.iso.datetime({ offset: true }).nullable(),
  /** Короткий итог шага: «65 пакетов», «нужна перезагрузка». */
  detail: z.string().nullable(),
});
export type MaintenanceStep = z.infer<typeof maintenanceStepSchema>;

export const MAINTENANCE_RUN_STATUSES = ['running', 'ok', 'failed'] as const;
export const maintenanceRunSchema = z.object({
  id: z.uuid(),
  serverId: z.uuid(),
  kind: z.enum(MAINTENANCE_KINDS),
  status: z.enum(MAINTENANCE_RUN_STATUSES),
  startedAt: z.iso.datetime({ offset: true }),
  finishedAt: z.iso.datetime({ offset: true }).nullable(),
  actorDisplay: z.string().nullable(),
  steps: z.array(maintenanceStepSchema),
  /** Вывод команд как есть; в списке запусков — пустая строка. */
  log: z.string(),
  error: z.string().nullable(),
});
export type MaintenanceRun = z.infer<typeof maintenanceRunSchema>;

export const maintenanceStateSchema = z.object({
  serverId: z.uuid(),
  check: maintenanceCheckSchema.nullable(),
  /** Последняя проверка не удалась (SSH недоступен и т.п.) — текст причины. */
  checkError: z.string().nullable(),
  nextCheckAt: z.iso.datetime({ offset: true }).nullable(),
  running: maintenanceRunSchema.nullable(),
  lastRun: maintenanceRunSchema.nullable(),
});
export type MaintenanceState = z.infer<typeof maintenanceStateSchema>;

export const startMaintenanceRequestSchema = z.object({ kind: z.enum(MAINTENANCE_KINDS) });
export type StartMaintenanceRequest = z.infer<typeof startMaintenanceRequestSchema>;

export const maintenanceRunsResponseSchema = z.object({ items: z.array(maintenanceRunSchema) });
export type MaintenanceRunsResponse = z.infer<typeof maintenanceRunsResponseSchema>;

/** «v0.5.4» и «0.5.4» — одна версия; сравнение по числам, хвосты вроде «-dev» считаются старше. */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => {
    const m = v
      .trim()
      .replace(/^v/i, '')
      .match(/^(\d+)\.(\d+)(?:\.(\d+))?(.*)$/);
    if (!m) return null;
    return { nums: [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)], tail: m[4] ?? '' };
  };
  const pa = parse(a);
  const pb = parse(b);
  if (!pa || !pb) return 0;
  for (let i = 0; i < 3; i++) {
    const d = (pa.nums[i] as number) - (pb.nums[i] as number);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  if (pa.tail === pb.tail) return 0;
  return pa.tail === '' ? 1 : pb.tail === '' ? -1 : 0;
}
