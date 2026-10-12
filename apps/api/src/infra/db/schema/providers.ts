import { sql } from 'drizzle-orm';
import { boolean, integer, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

/**
 * Провайдеры (хостеры): общий справочник, иконка с сайта хранится прямо в строке (≤64 КБ, base64).
 * Миграция 0019.
 */
export const providers = pgTable(
  'providers',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    name: text('name').notNull(),
    remotePanel: text('remote_panel'),
    remoteUuid: uuid('remote_uuid'),
    siteUrl: text('site_url').notNull(),
    note: text('note'),
    iconType: text('icon_type'),
    iconData: text('icon_data'),
    iconVersion: integer('icon_version').notNull().default(0),
    /** Ручная ссылка на иконку; null — ищем на сайте сами. */
    iconUrl: text('icon_url'),
    /** Откуда иконка взята фактически. */
    iconSourceUrl: text('icon_source_url'),
    /** Иконка ищется в фоне (после создания или смены сайта/ссылки). */
    iconPending: boolean('icon_pending').notNull().default(false),
    /** Архивный провайдер скрыт из справочника, но остаётся у старых оплат для точной истории. */
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('providers_legacy_name_unique').on(t.name).where(sql`${t.remotePanel} IS NULL`),
    uniqueIndex('providers_remote_identity_unique').on(t.remotePanel, t.remoteUuid),
  ],
);
export type ProviderRow = typeof providers.$inferSelect;
