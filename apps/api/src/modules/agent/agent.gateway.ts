import { createPublicKey, verify as edVerify, randomBytes, randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import {
  AGENT_MSG,
  AGENT_PROTOCOL_VERSION,
  type AgentEnvelope,
  type AgentErrorPayload,
  agentAuthSchema,
  agentEnvelopeSchema,
  agentHelloSchema,
  agentMetricsSchema,
} from '@nodeservice/shared';
import { WebSocket, WebSocketServer } from 'ws';

import type { ServerRow } from '../../infra/db/schema/index.js';
import { WsUpgradeService } from '../../infra/ws/ws-upgrade.service.js';
import { AuditService } from '../audit/audit.service.js';
import { AgentService } from './agent.service.js';

export const AGENT_WS_PATH = '/api/agent/v1/ws';
/** Сколько ждём hello+auth, прежде чем разорвать неавторизованное соединение. */
const AUTH_TIMEOUT_MS = 10_000;
const PING_INTERVAL_MS = 30_000;

/** DER-префикс SPKI для ed25519: раскодированный base64-ключ агента (32 байта) собираем в KeyObject. */
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

interface ConnState {
  stage: 'hello' | 'challenged' | 'ready';
  server?: ServerRow;
  version?: string;
  pubkey?: string;
  nonce?: Buffer;
}

/**
 * Шлюз агентов: сырой ws поверх HTTP-сервера панели (upgrade на /api/agent/v1/ws).
 * Аутентификация — challenge-response подписью ed25519 (ключ запиннен при энроллменте).
 */
@Injectable()
export class AgentGateway implements OnModuleDestroy {
  private readonly log = new Logger(AgentGateway.name);
  private wss: WebSocketServer | null = null;
  private ping: NodeJS.Timeout | null = null;
  /** Актуальное соединение каждого сервера: переподключение вытесняет старое без ложного offline. */
  private readonly active = new Map<string, WebSocket>();

  constructor(
    private readonly agents: AgentService,
    private readonly wsUpgrade: WsUpgradeService,
    private readonly audit: AuditService,
  ) {}

  register(): void {
    this.wss = new WebSocketServer({ noServer: true });
    this.wsUpgrade.register(AGENT_WS_PATH, (req, socket, head) => {
      this.wss?.handleUpgrade(req, socket, head, (ws) => this.handle(ws, req));
    });
    this.ping = setInterval(() => {
      for (const ws of this.wss?.clients ?? []) {
        const alive = (ws as WebSocket & { isAlive?: boolean }).isAlive;
        if (alive === false) {
          ws.terminate();
          continue;
        }
        (ws as WebSocket & { isAlive?: boolean }).isAlive = false;
        ws.ping();
      }
    }, PING_INTERVAL_MS);
    this.log.log(`Шлюз агентов слушает ${AGENT_WS_PATH}`);
  }

  onModuleDestroy(): void {
    if (this.ping) clearInterval(this.ping);
    this.wss?.close();
    for (const ws of this.wss?.clients ?? []) ws.terminate();
  }

  private handle(ws: WebSocket, _req: IncomingMessage): void {
    const state: ConnState = { stage: 'hello' };
    (ws as WebSocket & { isAlive?: boolean }).isAlive = true;
    ws.on('pong', () => {
      (ws as WebSocket & { isAlive?: boolean }).isAlive = true;
    });
    const authTimer = setTimeout(() => {
      if (state.stage !== 'ready') ws.close(4401, 'auth timeout');
    }, AUTH_TIMEOUT_MS);

    ws.on('message', (raw) => {
      void this.onMessage(ws, state, raw as Buffer).catch((err) => {
        this.log.warn(`Ошибка обработки сообщения агента: ${(err as Error).message}`);
        this.sendError(ws, 'protocol', 'Внутренняя ошибка обработки сообщения');
      });
    });
    ws.on('close', () => {
      clearTimeout(authTimer);
      const server = state.server;
      if (server && state.stage === 'ready' && this.active.get(server.id) === ws) {
        this.active.delete(server.id);
        void this.agents.markOffline(server, 'соединение закрыто');
      }
    });
    ws.on('error', () => {});
  }

  private async onMessage(ws: WebSocket, state: ConnState, raw: Buffer): Promise<void> {
    let env: AgentEnvelope;
    try {
      env = agentEnvelopeSchema.parse(JSON.parse(raw.toString('utf8')));
    } catch {
      this.sendError(ws, 'bad-envelope', 'Сообщение не соответствует конверту протокола v1');
      ws.close(4400, 'bad envelope');
      return;
    }

    if (state.stage === 'hello' && env.type === AGENT_MSG.hello) {
      const hello = agentHelloSchema.safeParse(env.payload);
      if (!hello.success) return this.fail(ws, 'bad-envelope', 'Неверный payload hello');
      const server = await this.agents.findServer(hello.data.serverId);
      if (!server?.agentPubkey) {
        await this.authFailed('unknown-server', hello.data.serverId, server?.name ?? null);
        return this.fail(ws, 'unknown-server', 'Сервер не знает такого агента');
      }
      // Пиннинг: ключ зафиксирован при энроллменте, смена — только новым токеном.
      if (server.agentPubkey !== hello.data.pubkey) {
        await this.authFailed('auth-failed', server.id, server.name);
        return this.fail(ws, 'auth-failed', 'Ключ агента не совпадает с запиннённым');
      }
      state.server = server;
      state.version = hello.data.version;
      state.pubkey = hello.data.pubkey;
      state.nonce = randomBytes(32);
      state.stage = 'challenged';
      this.send(ws, AGENT_MSG.challenge, { nonce: state.nonce.toString('base64') });
      return;
    }

    if (state.stage === 'challenged' && env.type === AGENT_MSG.auth) {
      const auth = agentAuthSchema.safeParse(env.payload);
      const { server, nonce, pubkey, version } = state;
      if (!auth.success || !server || !nonce || !pubkey || !version)
        return this.fail(ws, 'bad-envelope', 'Неверный payload auth');
      const key = createPublicKey({
        key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(pubkey, 'base64')]),
        format: 'der',
        type: 'spki',
      });
      const ok = edVerify(null, nonce, key, Buffer.from(auth.data.signature, 'base64'));
      if (!ok) return this.fail(ws, 'auth-failed', 'Подпись nonce не сошлась');
      state.stage = 'ready';
      // Переподключение вытесняет старое соединение этого же сервера (без ложного offline).
      const prev = this.active.get(server.id);
      this.active.set(server.id, ws);
      if (prev && prev !== ws) prev.terminate();
      await this.agents.markOnline(server, version);
      this.send(ws, AGENT_MSG.welcome, await this.agents.welcomeFor(server));
      return;
    }

    if (state.stage === 'ready' && state.server) {
      if (env.type === AGENT_MSG.heartbeat) return void (await this.agents.touch(state.server.id));
      if (env.type === AGENT_MSG.metrics) {
        const metrics = agentMetricsSchema.safeParse(env.payload);
        if (!metrics.success) return this.sendError(ws, 'bad-envelope', 'Неверный payload metrics');
        await this.agents.handleMetrics(state.server, metrics.data);
        return;
      }
    }

    this.sendError(ws, 'protocol', `Сообщение «${env.type}» не ожидается на этой стадии`);
  }

  /** Кто-то представился агентом, но не прошёл: чужой serverId или другой ключ — это важно видеть в Журнале. */
  private async authFailed(code: string, serverId: string, serverName: string | null): Promise<void> {
    await this.audit
      .record({
        action: 'server.agent.auth_failed',
        result: 'denied',
        severity: 'warn',
        source: 'auto',
        actor: { type: 'anonymous', id: null, display: 'агент' },
        target: { type: 'server', id: serverId, display: serverName ?? serverId },
        metadata: { code },
      })
      .catch(() => undefined);
  }

  private fail(ws: WebSocket, code: AgentErrorPayload['code'], message: string): void {
    this.sendError(ws, code, message);
    ws.close(4403, code);
  }

  private sendError(ws: WebSocket, code: AgentErrorPayload['code'], message: string): void {
    this.send(ws, AGENT_MSG.error, { code, message });
  }

  private send(ws: WebSocket, type: string, payload: unknown): void {
    if (ws.readyState !== WebSocket.OPEN) return;
    const env: AgentEnvelope = {
      v: AGENT_PROTOCOL_VERSION,
      type,
      id: randomUUID(),
      ts: new Date().toISOString(),
      payload,
    };
    ws.send(JSON.stringify(env));
  }
}
