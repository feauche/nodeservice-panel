import { pgTable, text, timestamp } from 'drizzle-orm/pg-core';

/**
 * Служебные key-value значения приложения (версия схемы, флаги первого запуска и т.п.).
 * Единственная таблица этапа 0 — чтобы проверить миграции и health-check БД.
 */
export const appMeta = pgTable('app_meta', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
