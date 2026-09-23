import { z } from 'zod';

/**
 * Центр уведомлений (колокольчик в шапке). Сюда падает всё, что панель показывает всплывашками,
 * плюс события, которые случаются без участия администратора (инциденты, обслуживание, фоновые
 * задачи). Хранится на сервере, чтобы не теряться между вкладками и устройствами.
 *
 *  GET    /api/notifications            → { items, unread, total } (последние NOTIFICATIONS_LIMIT)
 *  POST   /api/notifications            → Notification (клиент дублирует свои всплывашки)
 *  POST   /api/notifications/read-all   → { unread: 0 }
 *  DELETE /api/notifications/:id        → 204
 *  DELETE /api/notifications            → 204 (очистить все)
 *
 * Время везде — ISO в UTC; браузер показывает в своём часовом поясе.
 */

export const NOTIFICATION_SEVERITIES = ['info', 'ok', 'warn', 'crit'] as const;
export type NotificationSeverity = (typeof NOTIFICATION_SEVERITIES)[number];

export const NOTIFICATIONS_LIMIT = 200;
export const NOTIFICATION_TITLE_MAX = 200;
export const NOTIFICATION_BODY_MAX = 1000;

export const notificationLinkSchema = z.object({
  /** Путь внутри панели, например `/incidents?open=<id>`. */
  to: z.string().max(300),
  label: z.string().max(60),
});
export type NotificationLink = z.infer<typeof notificationLinkSchema>;

export const notificationSchema = z.object({
  id: z.uuid(),
  severity: z.enum(NOTIFICATION_SEVERITIES),
  title: z.string(),
  body: z.string().nullable(),
  link: notificationLinkSchema.nullable(),
  createdAt: z.iso.datetime({ offset: true }),
  readAt: z.iso.datetime({ offset: true }).nullable(),
});
export type Notification = z.infer<typeof notificationSchema>;

export const notificationsResponseSchema = z.object({
  items: z.array(notificationSchema),
  unread: z.number().int().min(0),
  total: z.number().int().min(0),
});
export type NotificationsResponse = z.infer<typeof notificationsResponseSchema>;

export const createNotificationRequestSchema = z.object({
  severity: z.enum(NOTIFICATION_SEVERITIES).default('info'),
  title: z.string().trim().min(1).max(NOTIFICATION_TITLE_MAX),
  body: z.string().trim().max(NOTIFICATION_BODY_MAX).optional(),
  link: notificationLinkSchema.optional(),
});
export type CreateNotificationRequest = z.input<typeof createNotificationRequestSchema>;
