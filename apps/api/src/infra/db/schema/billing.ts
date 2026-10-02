import type { BillingCurrency, BillingKind, BillingPeriodUnit } from '@nodeservice/shared';
import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

import { providers } from './servers.js';

/**
 * Биллинг (миграция 0043): что и когда оплачивать. Суммы — целые в копейках/центах.
 * Серверы хранятся списком id (сервер или серверы, где развёрнут сертификат): удалённые отфильтровываются при чтении.
 */
export const billingItems = pgTable(
  'billing_items',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    kind: text('kind').$type<BillingKind>().notNull(),
    title: text('title').notNull(),
    providerId: uuid('provider_id').references(() => providers.id, { onDelete: 'set null' }),
    serverIds: jsonb('server_ids').$type<string[]>().notNull().default([]),
    domain: text('domain'),
    amountMinor: bigint('amount_minor', { mode: 'number' }).notNull(),
    currency: text('currency').$type<BillingCurrency>().notNull(),
    periodUnit: text('period_unit').$type<BillingPeriodUnit>().notNull(),
    periodCount: integer('period_count').notNull().default(1),
    paidUntil: timestamp('paid_until', { withTimezone: true }).notNull(),
    /** Исходное число меся: 31 не теряется после короткого февраля. */
    billingDay: integer('billing_day').notNull().default(1),
    /** Календарь, в котором был задан срок. */
    billingTimeZone: text('billing_time_zone').notNull().default('Europe/Moscow'),
    autoCharge: boolean('auto_charge').notNull().default(false),
    remindDays: integer('remind_days'),
    note: text('note'),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    /** Какое напоминание уже ушло в Telegram для текущего срока: 'soon' | 'overdue'; сбрасывается продлением. */
    notifiedState: text('notified_state'),
    notifiedAt: timestamp('notified_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('billing_items_due_idx').on(t.paidUntil)],
);
export type BillingItemRow = typeof billingItems.$inferSelect;

/** Продления: сумма в валюте и в рублях по курсу ЦБ на день оплаты — задним числом не пересчитывается. */
export const billingPayments = pgTable(
  'billing_payments',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    itemId: uuid('item_id')
      .notNull()
      .references(() => billingItems.id, { onDelete: 'cascade' }),
    paidAt: timestamp('paid_at', { withTimezone: true }).notNull().defaultNow(),
    counted: boolean('counted').notNull(),
    amountMinor: bigint('amount_minor', { mode: 'number' }).notNull(),
    currency: text('currency').$type<BillingCurrency>().notNull(),
    rate: doublePrecision('rate').notNull(),
    amountRubMinor: bigint('amount_rub_minor', { mode: 'number' }).notNull(),
    extendedFrom: timestamp('extended_from', { withTimezone: true }).notNull(),
    extendedTo: timestamp('extended_to', { withTimezone: true }).notNull(),
    actorDisplay: text('actor_display'),
  },
  (t) => [
    index('billing_payments_item_idx').on(t.itemId, t.paidAt),
    index('billing_payments_paid_idx').on(t.paidAt),
  ],
);
export type BillingPaymentRow = typeof billingPayments.$inferSelect;

/** Курсы ЦБ РФ по дням (рублей за 1 $ и 1 €). */
export const billingRates = pgTable('billing_rates', {
  date: text('date').primaryKey(),
  usd: doublePrecision('usd').notNull(),
  eur: doublePrecision('eur').notNull(),
  fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull().defaultNow(),
});
