import { z } from 'zod';

/**
 * Инциденты (этап 8): панель сама замечает проблемы серверов (агент офлайн, SSH недоступен,
 * CPU/память/диск выше порога дольше «времени реакции»), заводит инцидент с таймлайном,
 * умеет чинить безопасными пресетами (по SSH) — вручную или, если включено, автоматически.
 */

export const INCIDENT_SEVERITIES = ['crit', 'warn', 'info'] as const;
export type IncidentSeverity = (typeof INCIDENT_SEVERITIES)[number];

export const INCIDENT_STATUSES = ['open', 'acknowledged', 'resolved'] as const;
export type IncidentStatus = (typeof INCIDENT_STATUSES)[number];

/** Виды инцидентов, которые панель умеет замечать. */
export const INCIDENT_KINDS = ['agent_offline', 'ssh_down', 'cpu_high', 'mem_high', 'disk_high'] as const;
export type IncidentKind = (typeof INCIDENT_KINDS)[number];

export const INCIDENT_KIND_META: Record<
  IncidentKind,
  { label: string; component: string; severity: IncidentSeverity }
> = {
  agent_offline: { label: 'Агент не в сети', component: 'Связь', severity: 'crit' },
  ssh_down: { label: 'SSH недоступен', component: 'Связь', severity: 'crit' },
  cpu_high: { label: 'Высокая нагрузка на CPU', component: 'CPU', severity: 'warn' },
  mem_high: { label: 'Память на пределе', component: 'Память', severity: 'warn' },
  disk_high: { label: 'Диск заполняется', component: 'Диск', severity: 'warn' },
};

/** Событие таймлайна инцидента. */
export const incidentEventResultSchema = z.enum([
  'detect',
  'notify',
  'applied',
  'helped',
  'failed',
  'escalate',
  'resolved',
]);
export type IncidentEventResult = z.infer<typeof incidentEventResultSchema>;

export const incidentEventSchema = z.object({
  at: z.iso.datetime(),
  by: z.enum(['auto', 'manual']),
  action: z.string(),
  result: incidentEventResultSchema,
});
export type IncidentEvent = z.infer<typeof incidentEventSchema>;

export const incidentSchema = z.object({
  id: z.uuid(),
  serverId: z.uuid().nullable(),
  serverName: z.string(),
  kind: z.enum(INCIDENT_KINDS),
  severity: z.enum(INCIDENT_SEVERITIES),
  status: z.enum(INCIDENT_STATUSES),
  title: z.string(),
  detail: z.string(),
  openedAt: z.iso.datetime(),
  resolvedAt: z.iso.datetime().nullable(),
  resolvedBy: z.enum(['auto', 'manual']).nullable(),
  timeline: z.array(incidentEventSchema),
});
export type Incident = z.infer<typeof incidentSchema>;

export const incidentsListQuerySchema = z.object({
  status: z.enum(['all', 'open', 'resolved']).default('all'),
});
export type IncidentsListQuery = z.infer<typeof incidentsListQuerySchema>;

export const incidentsListResponseSchema = z.object({
  items: z.array(incidentSchema),
  counts: z.object({ open: z.number().int(), crit: z.number().int(), warn: z.number().int() }),
});
export type IncidentsListResponse = z.infer<typeof incidentsListResponseSchema>;

/* ---------- пресеты автопочинки (встроенный реестр, без shell из БД) ---------- */

export const AUTOFIX_PRESETS = [
  {
    key: 'restart_xray',
    title: 'Перезапустить Xray',
    description: 'systemctl restart xray, иначе — рестарт контейнера ноды.',
    kinds: ['cpu_high'] as IncidentKind[],
  },
  {
    key: 'restart_node',
    title: 'Перезапустить контейнер ноды',
    description: 'docker restart remnanode — снимает утечки памяти в контейнере.',
    kinds: ['mem_high'] as IncidentKind[],
  },
  {
    key: 'free_disk',
    title: 'Освободить диск',
    description: 'Чистка journald и docker: vacuum логов + prune неиспользуемых образов.',
    kinds: ['disk_high'] as IncidentKind[],
  },
] as const;
export type AutofixPresetKey = (typeof AUTOFIX_PRESETS)[number]['key'];
export const autofixPresetKeySchema = z.enum(
  AUTOFIX_PRESETS.map((p) => p.key) as [AutofixPresetKey, ...AutofixPresetKey[]],
);
export const autofixRunRequestSchema = z.object({ preset: autofixPresetKeySchema });
export type AutofixRunRequest = z.infer<typeof autofixRunRequestSchema>;

/* ---------- настройки инцидентов (Настройки → Инциденты) ---------- */

const pct = (min: number, max: number) => z.coerce.number().int().min(min).max(max);

export const incidentsSettingsSchema = z.object({
  /** Порог «времени реакции»: проблема должна держаться дольше, чтобы стать инцидентом. */
  forDurationMinutes: z.coerce.number().int().min(1).max(60),
  cpuPct: pct(50, 100),
  memPct: pct(50, 100),
  diskPct: pct(50, 100),
  /** Автопочинка сама применяет безопасный пресет (иначе — только заводит инцидент). */
  autofixEnabled: z.boolean(),
  /** Не повторять автопочинку одного инцидента чаще, чем раз в N минут. */
  autofixCooldownMinutes: z.coerce.number().int().min(1).max(240),
});
export type IncidentsSettings = z.infer<typeof incidentsSettingsSchema>;

export const INCIDENTS_SETTINGS_DEFAULTS: IncidentsSettings = {
  forDurationMinutes: 5,
  cpuPct: 90,
  memPct: 90,
  diskPct: 85,
  autofixEnabled: false,
  autofixCooldownMinutes: 30,
};

export const incidentsSettingsUpdateSchema = incidentsSettingsSchema.partial();
export type IncidentsSettingsUpdate = z.infer<typeof incidentsSettingsUpdateSchema>;
