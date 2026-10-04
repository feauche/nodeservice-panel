import { z } from 'zod';

import { NODE_LINK_BY } from './servers.js';

/**
 * Подключение к панели Remnawave (J4), только чтение. Владелец создаёт в самой Remnawave токен API
 * с правами только на чтение (в её разделе «API Tokens») и вставляет сюда домен и токен один раз.
 * Наша панель со своей стороны никогда не вызывает эндпоинты записи Remnawave — какие бы права у
 * токена ни были, а Remnawave не даёт способа заранее узнать права чужого токена (нет самопроверки),
 * поэтому мы не утверждаем, что «проверили» его права: доверяем тому, что владелец создал его как read-only.
 */

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
  serverIds: z.array(z.string()).optional(),
  /** Как найдена связь с основным сервером; null — связи нет. */
  linkedBy: z.enum(NODE_LINK_BY).nullable().optional(),
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
  /** Сервисная подписка для настоящих VPN-проб сохранена; сама секретная ссылка никогда не возвращается. */
  vpnProbeConfigured: z.boolean().default(false),
  vpnProbeRoutes: z.number().int().min(0).nullable().default(null),
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

export const remnawaveVpnProbeRequestSchema = z.object({
  subscriptionUrl: z
    .url()
    .max(4000)
    .refine((value) => value.startsWith('https://'), 'нужна HTTPS-ссылка'),
});
export type RemnawaveVpnProbeRequest = z.infer<typeof remnawaveVpnProbeRequestSchema>;

export const remnawaveVpnProbeStatusSchema = z.object({
  configured: z.boolean(),
  routes: z.number().int().min(0).nullable(),
});
export type RemnawaveVpnProbeStatus = z.infer<typeof remnawaveVpnProbeStatusSchema>;
