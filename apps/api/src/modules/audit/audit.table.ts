import type { AuditChanges } from '@nodeservice/shared';
import { sql } from 'drizzle-orm';
import { bigint, integer, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

/**
 * Описание audit_log для запросов Drizzle. Таблица создаётся raw-миграцией 0002_audit.sql
 * (партиции, триггеры, tsvector) и намеренно НЕ входит в infra/db/schema — drizzle-kit о ней не знает.
 * Колонка `search` (tsvector) здесь не описана: в запросах она используется через sql``.
 */
export const auditLog = pgTable('audit_log', {
  id: uuid('id').notNull().default(sql`uuidv7()`),
  seq: bigint('seq', { mode: 'number' }).notNull().generatedAlwaysAsIdentity(),
  occurredAt: timestamp('occurred_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  actorType: text('actor_type').notNull(),
  actorId: text('actor_id'),
  actorDisplay: text('actor_display').notNull(),
  action: text('action').notNull(),
  category: text('category').notNull(),
  targetType: text('target_type'),
  targetId: text('target_id'),
  targetDisplay: text('target_display'),
  result: text('result').notNull(),
  severity: text('severity').notNull(),
  source: text('source').notNull(),
  /** В БД — inet; pg отдаёт строкой. */
  ip: text('ip'),
  userAgent: text('user_agent'),
  requestId: text('request_id'),
  durationMs: integer('duration_ms'),
  changes: jsonb('changes').$type<AuditChanges | null>(),
  metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull(),
});

export type AuditRow = typeof auditLog.$inferSelect;
export type AuditInsert = typeof auditLog.$inferInsert;
