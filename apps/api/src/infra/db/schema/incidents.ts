import type { IncidentEvent } from '@nodeservice/shared';
import { sql } from 'drizzle-orm';
import { index, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

import { servers } from './servers.js';

/** Инциденты (этап 8). Таблица и частичный уникальный индекс — миграция 0011_incidents.sql. */
export const incidents = pgTable(
  'incidents',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    serverId: uuid('server_id').references(() => servers.id, { onDelete: 'set null' }),
    serverName: text('server_name').notNull(),
    kind: text('kind').notNull(),
    severity: text('severity').notNull(),
    status: text('status').notNull().default('open'),
    title: text('title').notNull(),
    detail: text('detail').notNull().default(''),
    timeline: jsonb('timeline').$type<IncidentEvent[]>().notNull().default([]),
    lastAutofixAt: timestamp('last_autofix_at', { withTimezone: true }),
    openedAt: timestamp('opened_at', { withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    resolvedBy: text('resolved_by'),
  },
  (t) => [index('incidents_opened_idx').on(t.openedAt)],
);

export type IncidentRow = typeof incidents.$inferSelect;
