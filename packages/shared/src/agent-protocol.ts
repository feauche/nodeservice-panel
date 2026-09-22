import { z } from 'zod';

/**
 * Протокол агент↔панель, версия 1 (docs/protocol.md).
 * Агент сам ходит к панели: HTTP-энроллмент по одноразовому токену, затем исходящий WebSocket.
 * Конверт версионирован с первого сообщения — смешанный парк при обновлении различим.
 */
export const AGENT_PROTOCOL_VERSION = 1;

/** Как часто агент шлёт heartbeat; порог offline настраивается в «Автопроверках». */
export const AGENT_HEARTBEAT_SECONDS = 10;

/* ---------- HTTP: энроллмент ---------- */

/** POST /api/agent/v1/enroll — обмен одноразового токена на привязку ключа агента (TOFU). */
export const agentEnrollRequestSchema = z.object({
  token: z.string().min(10).max(200),
  /** Публичный ключ ed25519 агента, base64 (32 байта). Панель пиннит его навсегда. */
  pubkey: z.base64().min(40).max(60),
  version: z.string().min(1).max(50),
  hostname: z.string().max(120).optional(),
});
export type AgentEnrollRequest = z.infer<typeof agentEnrollRequestSchema>;

export const agentEnrollResponseSchema = z.object({
  serverId: z.uuid(),
  serverName: z.string(),
  /** Куда подключаться по WebSocket (полный URL, ws:// или wss://). */
  wsUrl: z.string(),
});
export type AgentEnrollResponse = z.infer<typeof agentEnrollResponseSchema>;

/* ---------- WebSocket: конверт ---------- */

export const agentEnvelopeSchema = z.object({
  v: z.literal(AGENT_PROTOCOL_VERSION),
  type: z.string().min(1).max(40),
  /** id сообщения (uuid) — для корреляции команд и ответов. */
  id: z.uuid(),
  ts: z.iso.datetime(),
  payload: z.unknown().optional(),
});
export type AgentEnvelope = z.infer<typeof agentEnvelopeSchema>;

/* ---------- агент → панель ---------- */

/** Первое сообщение после подключения: кто я. Панель ответит challenge. */
export const agentHelloSchema = z.object({
  serverId: z.uuid(),
  pubkey: z.base64().min(40).max(60),
  version: z.string().min(1).max(50),
});
export type AgentHello = z.infer<typeof agentHelloSchema>;

/** Подпись nonce из challenge приватным ключом агента (base64, 64 байта подписи). */
export const agentAuthSchema = z.object({
  signature: z.base64().min(80).max(100),
});
export type AgentAuth = z.infer<typeof agentAuthSchema>;

export const agentMetricsSchema = z.object({
  cpuPct: z.number().min(0).max(100),
  load1: z.number().min(0),
  memUsedMb: z.number().int().min(0),
  memTotalMb: z.number().int().min(0),
  diskUsedMb: z.number().int().min(0),
  diskTotalMb: z.number().int().min(0),
  netRxBps: z.number().min(0),
  netTxBps: z.number().min(0),
  netRxPps: z.number().min(0),
  netTxPps: z.number().min(0),
  /** null — conntrack недоступен (нет модуля/прав). */
  conntrackCount: z.number().int().min(0).nullable(),
  uptimeSec: z.number().int().min(0),
});
export type AgentMetrics = z.infer<typeof agentMetricsSchema>;

/* ---------- панель → агент ---------- */

export const agentChallengeSchema = z.object({
  /** Случайный nonce (base64), агент подписывает его ed25519-ключом. */
  nonce: z.base64().min(40).max(100),
});
export type AgentChallenge = z.infer<typeof agentChallengeSchema>;

/** Успешная аутентификация: параметры работы (из настроек «Автопроверки»). */
export const agentWelcomeSchema = z.object({
  serverName: z.string(),
  heartbeatSeconds: z.number().int().min(5).max(120),
  /** 0 — метрики выключены в настройках. */
  metricsSeconds: z.number().int().min(0).max(600),
});
export type AgentWelcome = z.infer<typeof agentWelcomeSchema>;

export const agentErrorSchema = z.object({
  code: z.enum(['bad-envelope', 'auth-failed', 'unknown-server', 'protocol']),
  message: z.string(),
});
export type AgentErrorPayload = z.infer<typeof agentErrorSchema>;

/** Типы сообщений v1. Команды (агенту) появятся этапом позже — конверт уже готов. */
export const AGENT_MSG = {
  // агент → панель
  hello: 'hello',
  auth: 'auth',
  heartbeat: 'heartbeat',
  metrics: 'metrics',
  // панель → агент
  challenge: 'challenge',
  welcome: 'welcome',
  error: 'error',
} as const;
