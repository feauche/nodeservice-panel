import { sql } from 'drizzle-orm';
import { boolean, index, integer, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

/**
 * Этап 4: инвентарь серверов. Пароли SSH не хранятся никогда;
 * свой приватный ключ — только зашифрованным (AES-256-GCM, см. CryptoService).
 * Таблицы созданы raw-миграцией 0004_servers.sql (уникальности и CHECK — там).
 */
export const servers = pgTable('servers', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  name: text('name').notNull().unique(),
  host: text('host').notNull(),
  port: integer('port').notNull().default(22),
  sshUser: text('ssh_user').notNull(),
  /** 'panel-key' — ключ панели; 'key' — свой ключ (ssh_private_key_enc). */
  authMethod: text('auth_method').notNull().default('panel-key'),
  sshPrivateKeyEnc: text('ssh_private_key_enc'),
  tags: jsonb('tags').$type<string[]>().notNull().default([]),
  notes: text('notes'),
  /* факты (обновляются при каждой успешной проверке SSH) */
  hostname: text('hostname'),
  os: text('os'),
  osVersion: text('os_version'),
  arch: text('arch'),
  kernel: text('kernel'),
  cpuCores: integer('cpu_cores'),
  memoryMb: integer('memory_mb'),
  /** SHA256-отпечаток host key (TOFU): смена → 409, доверить можно только явно. */
  hostKeyFp: text('host_key_fp'),
  agentStatus: text('agent_status').notNull().default('not_installed'),
  /** TOFU-пиннинг: ed25519-ключ агента фиксируется при энроллменте, менять — только новым токеном. */
  agentPubkey: text('agent_pubkey'),
  agentVersion: text('agent_version'),
  agentEnrolledAt: timestamp('agent_enrolled_at', { withTimezone: true }),
  agentLastSeenAt: timestamp('agent_last_seen_at', { withTimezone: true }),
  sshOk: boolean('ssh_ok'),
  lastSshCheckAt: timestamp('last_ssh_check_at', { withTimezone: true }),
  lastSshOkAt: timestamp('last_ssh_ok_at', { withTimezone: true }),
  /** Ручной порядок карточек (drag-and-drop). */
  sortOrder: integer('sort_order').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export type ServerRow = typeof servers.$inferSelect;

/** Токены подключения агента (этап 5): в БД — только sha256, TTL и лимит использований. */
export const enrollmentTokens = pgTable(
  'enrollment_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    serverId: uuid('server_id')
      .notNull()
      .references(() => servers.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull().unique(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
    maxUses: integer('max_uses').notNull().default(1),
    uses: integer('uses').notNull().default(0),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('enrollment_tokens_server_idx').on(t.serverId)],
);

export type EnrollmentTokenRow = typeof enrollmentTokens.$inferSelect;
