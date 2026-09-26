import type {
  MaintenanceCheck,
  MaintenanceKind,
  MaintenanceStep,
  ServerInventory,
} from '@nodeservice/shared';
import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

/**
 * Этап 4: инвентарь серверов. Пароли SSH не хранятся никогда;
 * свой приватный ключ — только зашифрованным (AES-256-GCM, см. CryptoService).
 * Таблицы созданы raw-миграцией 0004_servers.sql (уникальности и CHECK — там).
 */
/**
 * Провайдеры (хостеры): общий справочник, иконка с сайта хранится прямо в строке (≤64 КБ, base64).
 * Миграция 0019.
 */
export const providers = pgTable('providers', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  name: text('name').notNull().unique(),
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
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
export type ProviderRow = typeof providers.$inferSelect;

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
  /** Хостер из справочника providers; при удалении провайдера сбрасывается в NULL (миграция 0019). */
  providerId: uuid('provider_id').references(() => providers.id, { onDelete: 'set null' }),
  /** Слежение за контейнером ноды: auto / on / off (миграция 0027). */
  nodeWatch: text('node_watch').notNull().default('auto'),
  /** Последнее состояние контейнера по зонду: running / stopped / none. */
  nodeState: text('node_state'),
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
  /* профиль в парке (миграция 0034): знание владельца и снимок фактического состояния */
  role: text('role'),
  importance: text('importance').notNull().default('normal'),
  maintenanceWindow: text('maintenance_window'),
  expectedContainers: jsonb('expected_containers').$type<string[]>().notNull().default([]),
  expectedPorts: jsonb('expected_ports').$type<number[]>().notNull().default([]),
  inventory: jsonb('inventory').$type<Omit<ServerInventory, 'at'>>(),
  inventoryAt: timestamp('inventory_at', { withTimezone: true }),
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

/**
 * История веб-терминала (этап R1.7): запись вывода каждой PTY-сессии — то, что видел оператор.
 * Ввод не пишется (пароли с выключенным эхом никогда не попадают в запись). Миграция 0017.
 */
export const terminalSessions = pgTable(
  'terminal_sessions',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    serverId: uuid('server_id')
      .notNull()
      .references(() => servers.id, { onDelete: 'cascade' }),
    actorId: uuid('actor_id'),
    actorDisplay: text('actor_display'),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    endedAt: timestamp('ended_at', { withTimezone: true }),
    cols: integer('cols').notNull().default(80),
    rows: integer('rows').notNull().default(24),
    transcript: text('transcript').notNull().default(''),
    bytesOut: bigint('bytes_out', { mode: 'number' }).notNull().default(0),
    truncated: boolean('truncated').notNull().default(false),
    exitCode: integer('exit_code'),
    endReason: text('end_reason'),
  },
  (t) => [index('terminal_sessions_server_idx').on(t.serverId, t.startedAt)],
);
export type TerminalSessionRow = typeof terminalSessions.$inferSelect;

/**
 * Обслуживание сервера (R1.8): результат суточной проверки и запуски действий с пошаговым логом.
 * Миграция 0018. Форматы `check` и `steps` — packages/shared/src/maintenance.ts.
 */
export const maintenanceState = pgTable('maintenance_state', {
  serverId: uuid('server_id')
    .primaryKey()
    .references(() => servers.id, { onDelete: 'cascade' }),
  checkedAt: timestamp('checked_at', { withTimezone: true }),
  check: jsonb('check').$type<MaintenanceCheck>(),
  checkError: text('check_error'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
export type MaintenanceStateRow = typeof maintenanceState.$inferSelect;

export const maintenanceRuns = pgTable(
  'maintenance_runs',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    serverId: uuid('server_id')
      .notNull()
      .references(() => servers.id, { onDelete: 'cascade' }),
    kind: text('kind').$type<MaintenanceKind>().notNull(),
    status: text('status').$type<'running' | 'ok' | 'failed'>().notNull().default('running'),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    actorId: uuid('actor_id'),
    actorDisplay: text('actor_display'),
    steps: jsonb('steps').$type<MaintenanceStep[]>().notNull().default([]),
    log: text('log').notNull().default(''),
    error: text('error'),
  },
  (t) => [
    index('maintenance_runs_server_idx').on(t.serverId, t.startedAt),
    uniqueIndex('maintenance_runs_one_running').on(t.serverId).where(sql`${t.status} = 'running'`),
  ],
);
export type MaintenanceRunRow = typeof maintenanceRuns.$inferSelect;
