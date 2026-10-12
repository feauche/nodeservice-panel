import { sql } from 'drizzle-orm';
import { bigint, index, integer, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

import { incidents } from './incidents.js';

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
 * Сообщения Telegram, которые ждут разбора Ассистента (миграция 0051). Раньше признак «ждёт отправки» жил
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

/**
 * Доставка Telegram, на которую сеть или API не ответили (миграция 0052). Запись создаётся отдельно для
 * каждого чата: успешные адресаты не получают дубль, неуспешные повторяются после перезапуска панели.
 */
export const telegramOutbox = pgTable(
  'telegram_outbox',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    destinationId: text('destination_id').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    attempts: integer('attempts').notNull().default(0),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).notNull().defaultNow(),
    lastError: text('last_error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('telegram_outbox_due_idx').on(t.nextAttemptAt, t.createdAt),
    index('telegram_outbox_destination_idx').on(t.destinationId, t.createdAt, t.id),
  ],
);
export type TelegramOutboxRow = typeof telegramOutbox.$inferSelect;
