import { z } from 'zod';

/** Ноды и метрики читаются из Remnawave. Название и ссылка провайдера сохраняются
 * обратно по его UUID только по явному действию владельца; остальные поля не изменяются. */

export const REMNAWAVE_PROBLEM = {
  domainUnreachable: 'urn:nodeservice:problem:remnawave-domain-unreachable',
  unauthorized: 'urn:nodeservice:problem:remnawave-unauthorized',
  notConnected: 'urn:nodeservice:problem:remnawave-not-connected',
} as const;

export const remnawaveNodeSchema = z.object({
  uuid: z.string(),
  name: z.string(),
  /** Адрес ноды в Remnawave — сверяется с адресом наших серверов, чтобы связать карточки без ручной настройки. */
  address: z.string(),
  port: z.number().int().nullable().optional(),
  countryCode: z.string().nullable(),
  isConnected: z.boolean(),
  isDisabled: z.boolean(),
  isConnecting: z.boolean(),
  lastStatusMessage: z.string().nullable(),
  usersOnline: z.number().int().min(0).nullable(),
  trafficUsedBytes: z.number().nullable(),
  trafficLimitBytes: z.number().nullable(),
  /**
   * Серверы NodeService, на которых работает эта нода (обычно один; первый — основной); пусто — сервер в
   * панели не найден. Считается при отдаче статуса: в сохранённом снимке Remnawave этих полей нет.
   */
  providerName: z.string().nullable().optional(),
  providerUuid: z.string().nullable().optional(),
  providerUrl: z.string().nullable().optional(),
  providerIcon: z.string().nullable().optional(),
  cpuCount: z.number().nullable().optional(),
  cpuModel: z.string().nullable().optional(),
  cpuPercent: z.number().nullable().optional(),
  memoryUsedBytes: z.number().nullable().optional(),
  memoryTotalBytes: z.number().nullable().optional(),
  loadAverage: z.array(z.number().nullable()).optional(),
  rxBytesPerSec: z.number().nullable().optional(),
  txBytesPerSec: z.number().nullable().optional(),
  uptime: z.string().nullable().optional(),
  nodeVersion: z.string().nullable().optional(),
  xrayVersion: z.string().nullable().optional(),
  /** Отметка «Сервер белого списка» из настроек ноды; считается при отдаче статуса. */
  whitelist: z.boolean().optional(),
});
export type RemnawaveNode = z.infer<typeof remnawaveNodeSchema>;

export const remnawaveStatsSchema = z.object({
  users: z.object({
    total: z.number().int().min(0),
    active: z.number().int().min(0),
    disabled: z.number().int().min(0),
    limited: z.number().int().min(0),
    expired: z.number().int().min(0),
  }),
  online: z.object({
    now: z.number().int().min(0),
    lastDay: z.number().int().min(0),
    lastWeek: z.number().int().min(0),
    never: z.number().int().min(0),
  }),
  nodesOnline: z.number().int().min(0),
  nodesTotal: z.number().int().min(0),
  /** Суммарный трафик за всё время, байт (у Remnawave приходит строкой — большие числа не помещаются в number). */
  trafficBytesLifetime: z.string(),
  panelVersion: z.string(),
  /** Аптайм процесса самой панели Remnawave, секунды. */
  panelUptimeSec: z.number().min(0),
});
export type RemnawaveStats = z.infer<typeof remnawaveStatsSchema>;

export const REMNAWAVE_CERT_STATUSES = ['ok', 'warn', 'expired', 'unknown'] as const;
export const remnawaveCertSchema = z.object({
  status: z.enum(REMNAWAVE_CERT_STATUSES),
  expiresAt: z.iso.datetime().nullable(),
  /** Может быть отрицательным, если срок уже прошёл. */
  daysLeft: z.number().int().nullable(),
  /** Почему status='unknown' (домен не ответил по HTTPS и т. п.). */
  note: z.string().nullable(),
});
export type RemnawaveCert = z.infer<typeof remnawaveCertSchema>;

/** За сколько дней до истечения сертификата панели предупреждать. */
export const REMNAWAVE_CERT_WARN_DAYS = 21;
/**
 * Как часто панель сама перечитывает Remnawave (сводку и онлайн нод), минуты. Раз в минуту — чтобы
 * «три проверки подряд» для падения онлайна занимали пару минут, а не четверть часа.
 */
export const REMNAWAVE_SYNC_INTERVAL_MIN = 1;
/** Сертификат панели Remnawave проверяем реже — он меняется раз в месяцы, минуты. */
export const REMNAWAVE_CERT_CHECK_INTERVAL_MIN = 30;

export const remnawaveStatusSchema = z.object({
  providerError: z.string().nullable().optional(),
  connected: z.boolean(),
  domain: z.string().nullable(),
  /** Время последнего успешного чтения. При ошибке не меняется. */
  checkedAt: z.iso.datetime().nullable(),
  /** Время последней попытки, успешной или нет. */
  lastAttemptAt: z.iso.datetime().nullable().optional(),
  /** Почему последняя проверка не удалась; null — всё в порядке или ещё не проверяли. */
  error: z.string().nullable(),
  stats: remnawaveStatsSchema.nullable(),
  nodes: z.array(remnawaveNodeSchema),
  cert: remnawaveCertSchema.nullable(),
});
export type RemnawaveStatus = z.infer<typeof remnawaveStatusSchema>;

export const remnawaveConnectRequestSchema = z.object({
  domain: z
    .string()
    .trim()
    .min(3)
    .max(255)
    .transform((v) => v.replace(/^https?:\/\//i, '').replace(/\/+$/, '')),
  apiKey: z.string().trim().min(8).max(2000),
});
export type RemnawaveConnectRequest = z.infer<typeof remnawaveConnectRequestSchema>;

export const REMNAWAVE_TOPOLOGY_STATUSES = ['ok', 'warning', 'error', 'unknown'] as const;
export const REMNAWAVE_TOPOLOGY_CONFIDENCE = ['confirmed', 'inferred', 'unknown'] as const;

/** Безопасная проекция схемы Remnawave: только связи и состояния, без UUID пользователей и ключей Xray. */
export const remnawaveTopologyHostSchema = z.object({
  id: z.string(),
  name: z.string(),
  address: z.string(),
  port: z.number().int().min(1).max(65_535),
  disabled: z.boolean(),
  profileUuid: z.string().nullable(),
  inboundUuid: z.string().nullable(),
  inboundTag: z.string().nullable(),
  protocol: z.string().nullable(),
  network: z.string().nullable(),
  security: z.string().nullable(),
  nodeUuids: z.array(z.string()),
  status: z.enum(REMNAWAVE_TOPOLOGY_STATUSES),
});
export type RemnawaveTopologyHost = z.infer<typeof remnawaveTopologyHostSchema>;

export const remnawaveTopologyNodeSchema = z.object({
  id: z.string(),
  name: z.string(),
  address: z.string(),
  countryCode: z.string().nullable(),
  connected: z.boolean(),
  disabled: z.boolean(),
  usersOnline: z.number().int().min(0).nullable(),
  profileUuid: z.string().nullable(),
  inboundUuids: z.array(z.string()),
  status: z.enum(REMNAWAVE_TOPOLOGY_STATUSES),
});
export type RemnawaveTopologyNode = z.infer<typeof remnawaveTopologyNodeSchema>;

export const remnawaveTopologyRouteSchema = z.object({
  id: z.string(),
  profileUuid: z.string(),
  profileName: z.string(),
  order: z.number().int().min(0),
  isDefault: z.boolean(),
  match: z.array(z.string()),
  inboundTags: z.array(z.string()),
  hostIds: z.array(z.string()),
  outboundTag: z.string(),
  outboundProtocol: z.string().nullable(),
  outboundAddress: z.string().nullable(),
  dialerProxy: z.string().nullable(),
  targetKind: z.enum(['internet', 'node', 'service', 'blocked', 'unknown']),
  targetLabel: z.string(),
  targetNodeUuids: z.array(z.string()),
  status: z.enum(REMNAWAVE_TOPOLOGY_STATUSES),
  confidence: z.enum(REMNAWAVE_TOPOLOGY_CONFIDENCE),
  note: z.string().nullable(),
  explanation: z.string(),
});
export type RemnawaveTopologyRoute = z.infer<typeof remnawaveTopologyRouteSchema>;

export const REMNAWAVE_PATH_SEGMENTS = [
  'client_host',
  'host_inbound',
  'inbound_entry',
  'entry_outbound',
  'outbound_exit',
  'exit_internet',
] as const;

/** Фактическое состояние участка. null означает, что карта знает конфигурацию, но участок ещё не измерялся. */
export const remnawavePathRuntimeSchema = z.object({
  status: z.enum(REMNAWAVE_TOPOLOGY_STATUSES),
  checkedAt: z.iso.datetime(),
  source: z.enum(['remnawave']),
  label: z.string(),
  detail: z.string(),
});

export const remnawavePathSegmentSchema = z.object({
  id: z.string(),
  kind: z.enum(REMNAWAVE_PATH_SEGMENTS),
  fromId: z.string(),
  toId: z.string(),
  status: z.enum(REMNAWAVE_TOPOLOGY_STATUSES),
  runtime: remnawavePathRuntimeSchema.nullable().default(null),
});

/**
 * Единая модель пути, которой пользуются карта, сценарии и Ассистент.
 * Техническое правило/outbound остаётся отдельным звеном и не маскируется под ноду.
 */
export const remnawaveTopologyPathSchema = z.object({
  id: z.string(),
  hostId: z.string(),
  inboundTag: z.string().nullable(),
  entryNodeUuid: z.string().nullable(),
  routeId: z.string().nullable(),
  outboundTag: z.string().nullable(),
  exitNodeUuid: z.string().nullable(),
  destination: z.enum(['internet', 'service', 'blocked', 'unknown']),
  status: z.enum(REMNAWAVE_TOPOLOGY_STATUSES),
  confidence: z.enum(REMNAWAVE_TOPOLOGY_CONFIDENCE),
  segments: z.array(remnawavePathSegmentSchema),
});
export type RemnawaveTopologyPath = z.infer<typeof remnawaveTopologyPathSchema>;

export const remnawaveTopologyProfileSchema = z.object({
  id: z.string(),
  name: z.string(),
  status: z.enum(REMNAWAVE_TOPOLOGY_STATUSES),
  hostIds: z.array(z.string()),
  nodeUuids: z.array(z.string()),
  inbounds: z.array(
    z.object({
      tag: z.string(),
      protocol: z.string().nullable(),
      port: z.number().int().min(1).max(65_535).nullable(),
      network: z.string().nullable(),
      security: z.string().nullable(),
    }),
  ),
  outbounds: z.array(
    z.object({
      tag: z.string().nullable(),
      protocol: z.string().nullable(),
      address: z.string().nullable(),
      dialerProxy: z.string().nullable(),
      usedByRules: z.number().int().min(0),
      purpose: z.string(),
      note: z.string(),
    }),
  ),
  routingRules: z.number().int().min(0),
  summary: z.string(),
});
export type RemnawaveTopologyProfile = z.infer<typeof remnawaveTopologyProfileSchema>;

export const remnawaveTopologyIssueSchema = z.object({
  id: z.string(),
  severity: z.enum(['error', 'warning', 'info']),
  kind: z.string(),
  title: z.string(),
  detail: z.string(),
  hostIds: z.array(z.string()),
  nodeUuids: z.array(z.string()),
  routeIds: z.array(z.string()),
});
export type RemnawaveTopologyIssue = z.infer<typeof remnawaveTopologyIssueSchema>;

export const remnawaveConfigChangeSchema = z.object({
  kind: z.enum(['host', 'node', 'route', 'profile']),
  entityId: z.string(),
  label: z.string(),
  field: z.string(),
  before: z.string().nullable(),
  after: z.string().nullable(),
});

export const remnawaveConfigSnapshotSchema = z.object({
  hash: z.string(),
  capturedAt: z.iso.datetime(),
  previousAt: z.iso.datetime().nullable(),
  changes: z.array(remnawaveConfigChangeSchema),
});
export type RemnawaveConfigSnapshot = z.infer<typeof remnawaveConfigSnapshotSchema>;

export const remnawaveTopologySchema = z.object({
  generatedAt: z.iso.datetime(),
  hosts: z.array(remnawaveTopologyHostSchema),
  nodes: z.array(remnawaveTopologyNodeSchema),
  routes: z.array(remnawaveTopologyRouteSchema),
  paths: z.array(remnawaveTopologyPathSchema).default([]),
  profiles: z.array(remnawaveTopologyProfileSchema).default([]),
  issues: z.array(remnawaveTopologyIssueSchema),
  /** Последняя сохранённая безопасная версия конфигурации и отличие от предыдущей. */
  configSnapshot: remnawaveConfigSnapshotSchema.nullable().default(null),
  summary: z.object({
    hosts: z.number().int().min(0),
    nodes: z.number().int().min(0),
    routes: z.number().int().min(0),
    errors: z.number().int().min(0),
    warnings: z.number().int().min(0),
  }),
  note: z.string(),
});
export type RemnawaveTopology = z.infer<typeof remnawaveTopologySchema>;

/** Local monitoring thresholds. Null inherits global policy; remote configuration is unchanged. */
export const nodePreferencesSchema = z.object({
  /** «Сервер белого списка (БС)»: IP ноды в белых списках мобильных операторов. Ассистент советует BS Checker. */
  whitelist: z.boolean().default(false),
  channelMbps: z.number().positive().max(1000000).nullable().default(null),
  note: z.string().trim().max(1000).default(''),
  cpuWarningPercent: z.number().int().min(1).max(100).nullable().default(null),
  memoryWarningPercent: z.number().int().min(1).max(100).nullable().default(null),
});
export type NodePreferences = z.infer<typeof nodePreferencesSchema>;

const providerWebUrl = z.url().refine((value) => {
  return /^https?:\/\//i.test(value) && !value.split('/')[2]?.includes('@');
}, 'Укажите ссылку HTTP или HTTPS без пароля');
export const remnaProviderUpdateSchema = z
  .object({
    name: z.string().trim().min(2).max(30).optional(),
    loginUrl: providerWebUrl.nullable().optional(),
  })
  .refine((value) => value.name !== undefined || value.loginUrl !== undefined, 'Укажите название или ссылку');
export const remnaProviderSchema = z.object({
  uuid: z.uuid(),
  name: z.string(),
  loginUrl: z.string().nullable(),
  faviconLink: z.string().nullable(),
  nodes: z.array(z.object({ uuid: z.string(), name: z.string(), countryCode: z.string().nullable() })),
});
export const remnaProvidersSchema = z.object({ providers: z.array(remnaProviderSchema) });
export type RemnaProvider = z.infer<typeof remnaProviderSchema>;
export type RemnaProviderUpdate = z.infer<typeof remnaProviderUpdateSchema>;

/** Local presentation only: never written to the upstream node order. */
export const nodeLayoutSchema = z
  .object({
    folders: z
      .array(z.object({ id: z.uuid(), name: z.string().trim().min(1).max(60) }))
      .max(50)
      .default([]),
    order: z.array(z.uuid()).max(2000).default([]),
    rootOrder: z
      .array(z.string().regex(/^(folder:)?[0-9a-f-]{36}$/i))
      .max(2050)
      .default([]),
    placement: z.record(z.uuid(), z.uuid()).default({}),
    collapsedFolders: z.array(z.uuid()).max(50).default([]),
  })
  .superRefine((value, ctx) => {
    const ids = new Set(value.folders.map((f) => f.id));
    if (
      ids.size !== value.folders.length ||
      new Set(value.order).size !== value.order.length ||
      new Set(value.rootOrder).size !== value.rootOrder.length ||
      new Set(value.collapsedFolders).size !== value.collapsedFolders.length
    )
      ctx.addIssue({ code: 'custom', message: 'Порядок содержит повторения.' });
    if (Object.keys(value.placement).some((id) => ids.has(id)))
      ctx.addIssue({ code: 'custom', message: 'Папки нельзя вкладывать друг в друга.' });
    if (Object.values(value.placement).some((id) => !ids.has(id)))
      ctx.addIssue({ code: 'custom', message: 'Папка не найдена.' });
    if (value.collapsedFolders.some((id) => !ids.has(id)))
      ctx.addIssue({ code: 'custom', message: 'Свёрнутая папка не найдена.' });
  });
export type NodeLayout = z.infer<typeof nodeLayoutSchema>;

export const remnaPermissionsSchema = z.object({
  items: z.array(
    z.object({
      scope: z.string(),
      label: z.string(),
      why: z.string(),
      state: z.enum(['granted', 'denied', 'unknown']),
      checkedAt: z.string().nullable(),
      /** Право на изменение, которое ещё не пробовали: когда оно проверится («при срабатывании сценария»). */
      when: z.string().optional(),
    }),
  ),
});
