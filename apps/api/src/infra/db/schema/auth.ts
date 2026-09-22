import { index, integer, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

/**
 * Этап 1: единственный администратор + 2FA.
 * Логин хранится в нижнем регистре (нормализуется в коде), поэтому обычный unique.
 */
export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  login: text('login').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  /** AES-256-GCM: "v{ver}:{iv}:{tag}:{ct}" (base64url). null — 2FA отключена. */
  totpSecretEnc: text('totp_secret_enc'),
  totpKeyVersion: integer('totp_key_version').notNull().default(1),
  /** null — секрет выдан, но код ещё не подтверждён (или 2FA отключена). */
  totpConfirmedAt: timestamp('totp_confirmed_at', { withTimezone: true }),
  passwordChangedAt: timestamp('password_changed_at', { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const recoveryCodes = pgTable(
  'recovery_codes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** argon2id (облегчённые параметры) от нормализованного кода — для проверки при входе. */
    codeHash: text('code_hash').notNull(),
    /** AES-256-GCM копия кода — чтобы показать повторно (step-up). null у кодов, выпущенных до этой колонки. */
    codeEnc: text('code_enc'),
    /** Порядок выпуска (0..9) — чтобы показывать коды в том же порядке, что и при выдаче. */
    position: integer('position').notNull().default(0),
    usedAt: timestamp('used_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('recovery_codes_user_idx').on(t.userId)],
);

export const trustedDevices = pgTable(
  'trusted_devices',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** sha256(token) — сам токен только в cookie у клиента. */
    tokenHash: text('token_hash').notNull().unique(),
    userAgent: text('user_agent').notNull().default(''),
    ipPrefix: text('ip_prefix').notNull().default(''),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('trusted_devices_user_idx').on(t.userId)],
);

/** Токен первого запуска: печатается в лог/CLI, в БД — только sha256. */
export const setupTokens = pgTable('setup_tokens', {
  id: uuid('id').primaryKey().defaultRandom(),
  tokenHash: text('token_hash').notNull().unique(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  usedAt: timestamp('used_at', { withTimezone: true }),
});

export type UserRow = typeof users.$inferSelect;
export type TrustedDeviceRow = typeof trustedDevices.$inferSelect;
