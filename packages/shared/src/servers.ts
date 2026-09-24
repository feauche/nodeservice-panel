import { z } from 'zod';

/**
 * Контракт серверов (этап 4): инвентарь + добавление по SSH.
 *
 *  GET    /api/servers                       → ServersResponse
 *  GET    /api/servers/:id                   → Server
 *  POST   /api/servers/test                  → TestConnectionResponse   (проверка доступов до создания)
 *  POST   /api/servers                       → Server                   (подключается, пиннит host key, ставит ключ панели)
 *  PATCH  /api/servers/:id                   → Server
 *  DELETE /api/servers/:id                   → 204                      (step-up)
 *  POST   /api/servers/:id/check             → Server                   (повторная проверка SSH + обновление фактов)
 *  POST   /api/servers/:id/trust-host-key    → Server                   (step-up: доверять новому отпечатку)
 *  GET    /api/servers/panel-key             → PanelKeyResponse         (публичный ключ панели)
 *  POST   /api/servers/:id/enrollment-token  → EnrollmentTokenResponse  (step-up: токен для агента, этап 5)
 *
 * Пароль используется один раз — поставить ключ панели в authorized_keys — и НЕ сохраняется.
 * Свой приватный ключ хранится зашифрованным (AES-256-GCM, ENCRYPTION_KEY).
 * Host key сервера фиксируется при добавлении (TOFU): смена → 409 hostKeyMismatch.
 */

export const SERVER_NAME_MIN = 2;
export const SERVER_NAME_MAX = 48;
export const SERVER_TAGS_MAX = 10;
export const SERVER_NOTES_MAX = 500;

export const serverNameSchema = z
  .string()
  .trim()
  .min(SERVER_NAME_MIN, `Название — от ${SERVER_NAME_MIN} символов`)
  .max(SERVER_NAME_MAX, `Название — до ${SERVER_NAME_MAX} символов`);

/** IP (v4/v6) или домен. Без протокола и пробелов. */
export const hostSchema = z
  .string()
  .trim()
  .min(1, 'Укажи IP или домен')
  .max(255)
  .regex(/^[a-zA-Z0-9._:[\]-]+$/, 'Только IP или домен — без протокола и пробелов');

export const sshPortSchema = z.coerce.number().int().min(1).max(65535).default(22);

export const sshUserSchema = z
  .string()
  .trim()
  .min(1, 'Укажи пользователя SSH')
  .max(64)
  .regex(/^[a-z_][a-z0-9_-]{0,63}$/i, 'Некорректное имя пользователя');

export const tagSchema = z
  .string()
  .trim()
  .min(1)
  .max(24, 'Тег — до 24 символов')
  .regex(/^[\p{L}\p{N}_-]+$/u, 'Тег — буквы, цифры, дефис');
/**
 * Нода на сервере: следить ли за контейнером `*remna*`. auto — судим, только если контейнер найден;
 * on — нода должна быть (нет контейнера — тоже инцидент); off — не следим (сервер без ноды или нода отключена намеренно).
 */
export const NODE_WATCH_MODES = ['auto', 'on', 'off'] as const;
export const nodeWatchSchema = z.enum(NODE_WATCH_MODES);
export type NodeWatch = z.infer<typeof nodeWatchSchema>;
export const NODE_WATCH_LABELS: Record<NodeWatch, string> = {
  auto: 'Определять автоматически',
  on: 'Есть, следить',
  off: 'Нет, не следить',
};
/** Что зонд видел в последний раз: контейнер работает / остановлен / не найден. */
export const NODE_STATES = ['running', 'stopped', 'none'] as const;
export const nodeStateSchema = z.enum(NODE_STATES);
export type NodeState = z.infer<typeof nodeStateSchema>;
export const NODE_STATE_LABELS: Record<NodeState, string> = {
  running: 'контейнер найден, работает',
  stopped: 'контейнер найден, остановлен',
  none: 'контейнер не найден',
};

export const tagsSchema = z.array(tagSchema).max(SERVER_TAGS_MAX, `До ${SERVER_TAGS_MAX} тегов`).default([]);

/* ---------- статусы ---------- */
export const AGENT_STATUSES = ['not_installed', 'pending', 'online', 'offline'] as const;
export type AgentStatus = (typeof AGENT_STATUSES)[number];

export const AGENT_STATUS_LABELS: Record<AgentStatus, string> = {
  not_installed: 'Агент не установлен',
  pending: 'Ожидает агента',
  online: 'Агент в сети',
  offline: 'Агент не в сети',
};

/* ---------- SSH-доступы ---------- */
export const SSH_KEY_MAX = 16_384;

export const sshAuthSchema = z.discriminatedUnion('method', [
  /** Пароль: используется один раз для установки ключа панели, не сохраняется. */
  z.object({ method: z.literal('password'), password: z.string().min(1, 'Введите пароль').max(256) }),
  /** Свой приватный ключ (OpenSSH/PEM); хранится зашифрованным. */
  z.object({
    method: z.literal('key'),
    privateKey: z.string().min(1, 'Вставь приватный ключ').max(SSH_KEY_MAX),
    passphrase: z.string().max(256).optional(),
  }),
  /** Ключ панели уже установлен на сервере. */
  z.object({ method: z.literal('panel-key') }),
]);
export type SshAuth = z.infer<typeof sshAuthSchema>;

/* ---------- факты о сервере ---------- */
export const serverFactsSchema = z.object({
  hostname: z.string().nullable(),
  /** Например «Ubuntu» (из /etc/os-release NAME). */
  os: z.string().nullable(),
  /** Например «24.04» (VERSION_ID). */
  osVersion: z.string().nullable(),
  /** uname -m: x86_64 / aarch64. */
  arch: z.string().nullable(),
  kernel: z.string().nullable(),
  cpuCores: z.number().int().nullable(),
  memoryMb: z.number().int().nullable(),
});
export type ServerFacts = z.infer<typeof serverFactsSchema>;

export const EMPTY_FACTS: ServerFacts = {
  hostname: null,
  os: null,
  osVersion: null,
  arch: null,
  kernel: null,
  cpuCores: null,
  memoryMb: null,
};

/* ---------- сервер ---------- */
export const serverSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  host: z.string(),
  port: z.number().int(),
  sshUser: z.string(),
  /** Чем ходим по SSH: ключ панели или свой ключ. Пароль не храним никогда. */
  authMethod: z.enum(['panel-key', 'key']),
  tags: z.array(z.string()),
  notes: z.string().nullable(),
  /** Хостер из справочника провайдеров; null — не указан. */
  providerId: z.uuid().nullable(),
  nodeWatch: nodeWatchSchema,
  /** Последнее, что видел зонд контейнера; null — ещё не проверяли или слежение выключено. */
  node: nodeStateSchema.nullable(),
  facts: serverFactsSchema,
  /** SHA256-отпечаток host key (формат OpenSSH: «SHA256:…»). */
  hostKeyFingerprint: z.string().nullable(),
  agentStatus: z.enum(AGENT_STATUSES),
  agentVersion: z.string().nullable(),
  agentLastSeenAt: z.iso.datetime().nullable(),
  /** Последняя проверка SSH прошла успешно; null — ещё не проверяли. */
  sshOk: z.boolean().nullable(),
  lastSshCheckAt: z.iso.datetime({ offset: true }).nullable(),
  lastSshOkAt: z.iso.datetime({ offset: true }).nullable(),
  createdAt: z.iso.datetime({ offset: true }),
  updatedAt: z.iso.datetime({ offset: true }),
});
export type Server = z.infer<typeof serverSchema>;

export const serversResponseSchema = z.object({ items: z.array(serverSchema) });
export type ServersResponse = z.infer<typeof serversResponseSchema>;

/* ---------- запросы ---------- */
export const testConnectionRequestSchema = z.object({
  host: hostSchema,
  port: sshPortSchema,
  sshUser: sshUserSchema,
  auth: sshAuthSchema,
});
export type TestConnectionRequest = z.infer<typeof testConnectionRequestSchema>;

export const testConnectionResponseSchema = z.object({
  hostKeyFingerprint: z.string(),
  facts: serverFactsSchema,
});
export type TestConnectionResponse = z.infer<typeof testConnectionResponseSchema>;

export const createServerRequestSchema = z.object({
  name: serverNameSchema,
  host: hostSchema,
  port: sshPortSchema,
  sshUser: sshUserSchema,
  auth: sshAuthSchema,
  tags: tagsSchema,
  notes: z.string().trim().max(SERVER_NOTES_MAX).optional(),
  providerId: z.uuid().nullable().optional(),
  nodeWatch: nodeWatchSchema.default('auto'),
  /**
   * Поставить ключ панели в authorized_keys и дальше ходить только по нему (по умолчанию).
   * false — остаться на своём ключе (для пароля всегда true: пароль не сохраняется).
   */
  installPanelKey: z.boolean().default(true),
  /**
   * false — добавить без SSH-подключения (статус «SSH не проверен», проверит автопроверка или вручную).
   * С паролем недопустимо: пароль не хранится и нужен один раз — чтобы поставить ключ панели.
   */
  verify: z.boolean().default(true),
});
export type CreateServerRequest = z.infer<typeof createServerRequestSchema>;

// Без .partial() поверх полей с .default(): default протекает в PATCH и молча меняет значения.
export const updateServerRequestSchema = z.object({
  name: serverNameSchema.optional(),
  host: hostSchema.optional(),
  port: z.coerce.number().int().min(1).max(65535).optional(),
  sshUser: sshUserSchema.optional(),
  tags: z.array(tagSchema).max(SERVER_TAGS_MAX, `До ${SERVER_TAGS_MAX} тегов`).optional(),
  notes: z.string().trim().max(SERVER_NOTES_MAX).nullable().optional(),
  providerId: z.uuid().nullable().optional(),
  nodeWatch: nodeWatchSchema.optional(),
  /** Новые доступы SSH: панель проверит их реальным подключением (пароль, как и при добавлении, не сохраняется). */
  auth: sshAuthSchema.optional(),
});
export type UpdateServerRequest = z.infer<typeof updateServerRequestSchema>;

export const trustHostKeyRequestSchema = z.object({
  /** Отпечаток, который показали в ошибке hostKeyMismatch — защита от слепого подтверждения. */
  fingerprint: z.string().min(10),
});
export type TrustHostKeyRequest = z.infer<typeof trustHostKeyRequestSchema>;

export const panelKeyResponseSchema = z.object({
  /** Строка для authorized_keys: «ssh-ed25519 AAAA… nodeservice-panel». */
  publicKey: z.string(),
});
export type PanelKeyResponse = z.infer<typeof panelKeyResponseSchema>;

/* ---------- токен подключения агента (используется этапом 5) ---------- */
export const ENROLLMENT_TOKEN_TTL_HOURS = 24;

export const enrollmentTokenResponseSchema = z.object({
  /** Показывается один раз; в БД — только хеш. */
  token: z.string(),
  serverId: z.uuid(),
  expiresAt: z.iso.datetime({ offset: true }),
  /** Команда установки агента на сервере (реальный скрипт появится с агентом, этап 5). */
  installCommand: z.string(),
});
export type EnrollmentTokenResponse = z.infer<typeof enrollmentTokenResponseSchema>;

/* ---------- ошибки ---------- */
export const SERVER_PROBLEM = {
  /** Не удалось подключиться (сеть/таймаут/порт). */
  sshUnreachable: 'https://nodeservice.dev/problems/servers/ssh-unreachable',
  /** Пароль/ключ не подошли. */
  sshAuth: 'https://nodeservice.dev/problems/servers/ssh-auth-failed',
  /** Host key сервера изменился (extensions.offeredFingerprint — новый отпечаток). */
  hostKeyMismatch: 'https://nodeservice.dev/problems/servers/host-key-mismatch',
  /** Команда на сервере завершилась с ошибкой. */
  sshCommand: 'https://nodeservice.dev/problems/servers/ssh-command-failed',
  /** Имя уже занято. */
  nameTaken: 'https://nodeservice.dev/problems/servers/name-taken',
  /** Такой хост уже добавлен. */
} as const;

/** Ручной порядок карточек: полный список id в новом порядке (лишние id игнорируются, не названные — в конец). */
export const reorderServersRequestSchema = z.object({
  ids: z.array(z.uuid()).min(1),
});
export type ReorderServersRequest = z.infer<typeof reorderServersRequestSchema>;
