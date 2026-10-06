import type { RemnawaveConfigSnapshot } from '@nodeservice/shared';
import { sql } from 'drizzle-orm';
import { index, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

/**
 * Безопасные версии топологии Remnawave. Здесь нет исходных Xray-конфигов, UUID клиентов,
 * ключей и токенов: хранится только та же очищенная проекция, которую видит граф.
 */
export const remnawaveConfigSnapshots = pgTable(
  'remnawave_config_snapshots',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    hash: text('hash').notNull(),
    snapshot: jsonb('snapshot').$type<Record<string, unknown>>().notNull(),
    changes: jsonb('changes').$type<RemnawaveConfigSnapshot['changes']>().notNull().default([]),
    capturedAt: timestamp('captured_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('remnawave_config_snapshots_captured_idx').on(table.capturedAt)],
);

export type RemnawaveConfigSnapshotRow = typeof remnawaveConfigSnapshots.$inferSelect;
