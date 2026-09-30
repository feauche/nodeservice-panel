import { sql } from 'drizzle-orm';
import { bigint, index, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

import { incidents } from './incidents.js';

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

/**
 * Какие сообщения Telegram ушли по инциденту (миграция 0041): «Починилось» отправляется ответом на
 * исходное сообщение в том же чате — в ленте видна пара «сломалось → починилось».
 */
export const telegramMessages = pgTable(
  'telegram_messages',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    incidentId: uuid('incident_id')
      .notNull()
      .references(() => incidents.id, { onDelete: 'cascade' }),
    destinationId: text('destination_id').notNull(),
    messageId: bigint('message_id', { mode: 'number' }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('telegram_messages_incident_idx').on(t.incidentId, t.destinationId)],
);

/**
 * Сообщения Telegram, которые ждут разбора Джарвиса (миграция 0051). Раньше признак «ждёт отправки» жил
 * только в памяти процесса, и перезапуск панели терял сообщение. `alert` — что отправить, `queued` —
 * события того же дела, вставшие за ним в очередь (их формат знает служба уведомлений).
 */
export const telegramPending = pgTable('telegram_pending', {
  incidentId: uuid('incident_id')
    .primaryKey()
    .references(() => incidents.id, { onDelete: 'cascade' }),
  alert: jsonb('alert').$type<Record<string, unknown>>().notNull(),
  queued: jsonb('queued').$type<Array<Record<string, unknown>>>().notNull().default([]),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
