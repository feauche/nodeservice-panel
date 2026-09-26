import type { KbSource } from '@nodeservice/shared';
import { sql } from 'drizzle-orm';
import { boolean, index, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

/** База знаний (этап 9). tsvector-колонка `search` и gin-индекс — миграция 0012. */
export const kbDocuments = pgTable(
  'kb_documents',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    title: text('title').notNull(),
    content: text('content').notNull().default(''),
    tags: jsonb('tags').$type<string[]>().notNull().default([]),
    archived: boolean('archived').notNull().default(false),
    /** Закреплена сверху и защищена от удаления (миграция 0033): глоссарий «Пояснения». */
    pinned: boolean('pinned').notNull().default(false),
    source: text('source').$type<KbSource>().notNull().default('self'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('kb_updated_idx').on(t.updatedAt)],
);
export type KbDocumentRow = typeof kbDocuments.$inferSelect;

/** История версий статьи (снимок предыдущего состояния перед изменением) — для отката. */
export const kbDocumentVersions = pgTable(
  'kb_document_versions',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    docId: uuid('doc_id')
      .notNull()
      .references(() => kbDocuments.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    content: text('content').notNull(),
    tags: jsonb('tags').$type<string[]>().notNull().default([]),
    source: text('source').$type<KbSource>().notNull(),
    archived: boolean('archived').notNull().default(false),
    reason: text('reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('kb_versions_doc_idx').on(t.docId, t.createdAt)],
);
export type KbDocumentVersionRow = typeof kbDocumentVersions.$inferSelect;

export const assistantConversations = pgTable('assistant_conversations', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  title: text('title').notNull().default('Новый чат'),
  /** Осталось от режима «Анализ»: режимов больше нет, колонка не используется, у всех бесед 'agent'. */
  mode: text('mode').notNull().default('agent'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
export type AssistantConversationRow = typeof assistantConversations.$inferSelect;

export const assistantMessages = pgTable(
  'assistant_messages',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => assistantConversations.id, { onDelete: 'cascade' }),
    role: text('role').notNull(),
    content: text('content').notNull(),
    citations: jsonb('citations').$type<unknown[]>().notNull().default([]),
    proposals: jsonb('proposals').$type<unknown[]>().notNull().default([]),
    /** Проверки доступности снаружи (миграция 0032). */
    reachability: jsonb('reachability').$type<unknown[]>().notNull().default([]),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('assistant_msg_conv_idx').on(t.conversationId, t.createdAt)],
);
export type AssistantMessageRow = typeof assistantMessages.$inferSelect;

/** Изменение по предложению Джарвиса (миграция 0035): args и plan хранятся, чтобы применить и откатить ровно то, что показали. */
export const assistantChanges = pgTable(
  'assistant_changes',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    conversationId: uuid('conversation_id').references(() => assistantConversations.id, {
      onDelete: 'set null',
    }),
    operation: text('operation').notNull(),
    args: jsonb('args').$type<Record<string, unknown>>().notNull(),
    reason: text('reason'),
    plan: jsonb('plan').$type<Record<string, unknown>>().notNull(),
    status: text('status').notNull().default('proposed'),
    note: text('note'),
    decidedBy: text('decided_by'),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    index('assistant_changes_created_idx').on(t.createdAt),
    index('assistant_changes_conv_idx').on(t.conversationId),
  ],
);
export type AssistantChangeRow = typeof assistantChanges.$inferSelect;
