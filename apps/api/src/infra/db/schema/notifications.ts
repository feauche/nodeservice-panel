import { sql } from 'drizzle-orm';
import { index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

/** Центр уведомлений (миграция 0023). Формат — packages/shared/src/notifications.ts. */
export const notifications = pgTable(
  'notifications',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    severity: text('severity').notNull().default('info'),
    title: text('title').notNull(),
    body: text('body'),
    linkTo: text('link_to'),
    linkLabel: text('link_label'),
    /** Сервер, о котором уведомление (миграция 0030): имя в тексте — токен `{server}`, подставляется при показе. */
    serverId: uuid('server_id'),
    /** Имя на момент создания — запасное, если сервер удалён. */
    serverName: text('server_name'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    readAt: timestamp('read_at', { withTimezone: true }),
  },
  (t) => [index('notifications_created_idx').on(t.createdAt)],
);
export type NotificationRow = typeof notifications.$inferSelect;
