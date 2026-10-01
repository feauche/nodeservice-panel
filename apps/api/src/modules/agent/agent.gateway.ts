import { createPublicKey, verify as edVerify, randomBytes, randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { isIP } from 'node:net';
import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
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
import {
  closePreAuth,
  holdPreAuth,
  ownOrReject,
  PreAuthLimiter,
  rejectUpgrade,
} from '../../infra/ws/ws-preauth.js';
import { WsUpgradeService } from '../../infra/ws/ws-upgrade.service.js';
import { AuditService } from '../audit/audit.service.js';
import { throttleIp } from '../auth/throttle.schedule.js';
import { ServersService } from '../servers/servers.service.js';
import { AgentService } from './agent.service.js';

export const AGENT_WS_PATH = '/api/agent/v1/ws';
/** Сколько ждём hello+auth, прежде чем разорвать неавторизованное соединение. */
const AUTH_TIMEOUT_MS = 10_000;
const PING_INTERVAL_MS = 30_000;
const MAX_MESSAGE_BYTES = 64 * 1024;
/**
 * До входа агент шлёт ровно два коротких сообщения — hello (~300 байт), затем auth: больше этого до входа
 * не принимаем. Крупное, второе до ответа на первое или не то по шагу — разрыв: иначе без ключа можно
 * было бы до таймаута входа слать панели сколько угодно сообщений по 64 КБ и гонять поиск сервера.
 */
const PREAUTH_MAX_MESSAGE_BYTES = 4 * 1024;
/**
 * Код закрытия «сервер удалён из панели». Отдельный от отказа входа (4403): агенту здесь больше нечего
 * делать, и переподключаться не нужно — следующая версия агента по этому коду сможет остановиться совсем.
 */
export const CLOSE_SERVER_DELETED = 4410;
/**
 * Отвергнутый агент (сервер удалён, старая копия после перепривязки) перезапускается и стучится каждые
 * ~5 секунд. «Подключение агента отклонено» пишем в Журнал не чаще раза в час на сервер, с числом попыток.
 */
const AUTH_FAILED_LOG_EVERY_MS = 60 * 60_000;
/** Сколько серверов помним по отдельности. Шлюз открыт всему интернету: сверх этого отказы считаем вместе. */
const AUTH_FAILED_TRACK_MAX = 500;
const AUTH_FAILED_OTHERS = '*';
/**
 * Список адресов серверов парка старше этого перечитываем, прежде чем отказать незнакомому адресу при
 * занятой прихожей: сервер могли только что добавить.
 */
const KNOWN_TTL_MS = 5_000;

/** DER-префикс SPKI для ed25519: раскодированный base64-ключ агента (32 байта) собираем в KeyObject. */
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

interface ConnState {
  stage: 'hello' | 'challenged' | 'ready';
  server?: ServerRow;
  version?: string;
  pubkey?: string;
  nonce?: Buffer;
  /** До входа: сообщение ещё проверяется — следующее ждать не будем. */
  pending?: boolean;
  /** Освободить место среди соединений без входа. */
  release?: () => void;
}

/**
 * Шлюз агентов: сырой ws поверх HTTP-сервера панели (upgrade на /api/agent/v1/ws).
 * Аутентификация — challenge-response подписью ed25519 (ключ запиннен при энроллменте).
 */
@Injectable()
export class AgentGateway implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(AgentGateway.name);
  private wss: WebSocketServer | null = null;
  private ping: NodeJS.Timeout | null = null;
  /** Актуальное соединение каждого сервера: переподключение вытесняет старое без ложного offline. */
  private readonly active = new Map<string, WebSocket>();
  /** Когда по серверу последний раз писали отказ в Журнал и сколько отказов с тех пор промолчали. */
  private readonly authFailures = new Map<string, { loggedAt: number; skipped: number }>();
  /** Соединения, ещё не прошедшие вход: не больше 5 с адреса и 50 всего (infra/ws/ws-preauth). */
  private readonly preAuth = new PreAuthLimiter();
  /** Адреса серверов парка (ключ как у предела: IPv6 — сеть /64) и когда список прочитан. */
  private known: { keys: Set<string>; at: number } = { keys: new Set(), at: 0 };
  private knownLoad: Promise<void> | null = null;

  constructor(
    private readonly agents: AgentService,
    private readonly wsUpgrade: WsUpgradeService,
    private readonly audit: AuditService,
    private readonly servers: ServersService,
  ) {}

  onModuleInit(): void {
    this.servers.onDeleted((id) => this.dropServer(id));
  }

  register(): void {
    // Сообщения агента — несколько сотен байт; без предела библиотека принимает до 100 МБ ещё до входа.
    this.wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES });
    this.wsUpgrade.register(AGENT_WS_PATH, (req, socket, head) => {
      const ip = this.wsUpgrade.clientIp(req);
      const open = (release: () => void) =>
        this.wss?.handleUpgrade(req, socket, head, (ws) => this.handle(ws, req, release));
      const release = holdPreAuth(this.preAuth, ip, socket);
      if (release) return open(release);
      // Прихожая занята: агента с адреса сервера парка пускаем сверх общего предела (но не больше пяти с
      // адреса) — иначе поток соединений без входа с нескольких адресов не давал бы парку переподключиться.
      void ownOrReject(socket, () => this.knownAddress(ip)).then((own) => {
        if (!own) return;
        const extra = holdPreAuth(this.preAuth, ip, socket, true);
        if (extra) open(extra);
        else rejectUpgrade(socket);
      });
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

  /** release — освободить место соединения без входа: зовём, когда агент вошёл (закрытие освобождает само). */
  private handle(ws: WebSocket, _req: IncomingMessage, release: () => void): void {
    const state: ConnState = { stage: 'hello', release };
    (ws as WebSocket & { isAlive?: boolean }).isAlive = true;
    ws.on('pong', () => {
      (ws as WebSocket & { isAlive?: boolean }).isAlive = true;
    });
    const authTimer = setTimeout(() => {
      if (state.stage !== 'ready') closePreAuth(ws, 4401, 'auth timeout');
    }, AUTH_TIMEOUT_MS);

    ws.on('message', (raw) => {
      // Закрытие уже начато (отказ, нарушение порядка): библиотека ещё отдаёт сообщения до ответа клиента,
      // но обрабатывать их незачем — иначе без входа можно было бы слать дальше, не отвечая на закрытие.
      if (ws.readyState !== WebSocket.OPEN) return;
      const data = raw as Buffer;
      if (state.stage !== 'ready') {
        if (state.pending || data.length > PREAUTH_MAX_MESSAGE_BYTES)
          return this.protocolClose(ws, 'До входа — одно короткое сообщение на шаг');
        state.pending = true;
      }
      void this.onMessage(ws, state, data)
        .catch((err) => {
          this.log.warn(`Ошибка обработки сообщения агента: ${(err as Error).message}`);
          this.sendError(ws, 'protocol', 'Внутренняя ошибка обработки сообщения');
        })
        .finally(() => {
          state.pending = false;
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
      if (state.stage === 'ready') ws.close(4400, 'bad envelope');
      else closePreAuth(ws, 4400, 'bad envelope');
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
      // Вошёл — место среди соединений без входа больше не занимает.
      state.release?.();
      // Переподключение вытесняет старое соединение этого же сервера (без ложного offline).
      const prev = this.active.get(server.id);
      this.active.set(server.id, ws);
      if (prev && prev !== ws) prev.terminate();
      // Агент вошёл — прежние отказы этому серверу закончились, счёт начинается заново.
      this.authFailures.delete(server.id);
      await this.agents.markOnline(server, version);
      this.send(ws, AGENT_MSG.welcome, await this.agents.welcomeFor(server));
      return;
    }

    if (state.stage === 'ready' && state.server && state.version) {
      if (env.type === AGENT_MSG.heartbeat) {
        if (!(await this.agents.touch(state.server.id, state.version)))
          this.closeDeleted(ws, state.server.id);
        return;
      }
      if (env.type === AGENT_MSG.metrics) {
        const metrics = agentMetricsSchema.safeParse(env.payload);
        if (!metrics.success) return this.sendError(ws, 'bad-envelope', 'Неверный payload metrics');
        if (!(await this.agents.handleMetrics(state.server, state.version, metrics.data)))
          this.closeDeleted(ws, state.server.id);
        return;
      }
    }

    // До входа ждём только hello, затем auth: не то по шагу — разрыв, а не вежливая ошибка без конца.
    if (state.stage !== 'ready')
      return this.protocolClose(ws, `Сообщение «${env.type}» не ожидается на этой стадии`);
    this.sendError(ws, 'protocol', `Сообщение «${env.type}» не ожидается на этой стадии`);
  }

  /** Нарушение порядка до входа: причина агенту (видна в его журнале) и разрыв. */
  private protocolClose(ws: WebSocket, message: string): void {
    this.sendError(ws, 'protocol', message);
    closePreAuth(ws, 4400, 'protocol');
  }

  /**
   * Адрес сервера парка: SSH-адрес или внешний адрес на его интерфейсах (IPv6 — сеть /64, как у предела).
   * Незнакомый адрес — перечитываем список, если он старше KNOWN_TTL_MS.
   */
  private async knownAddress(ip: string): Promise<boolean> {
    const key = throttleIp(ip);
    if (!this.known.keys.has(key) && Date.now() - this.known.at > KNOWN_TTL_MS) {
      this.knownLoad ??= this.loadKnown().finally(() => {
        this.knownLoad = null;
      });
      await this.knownLoad;
    }
    return this.known.keys.has(key);
  }

  private async loadKnown(): Promise<void> {
    try {
      const keys = new Set<string>();
      for (const s of await this.servers.list())
        for (const a of [s.host, ...(s.facts.addresses ?? [])]) if (isIP(a)) keys.add(throttleIp(a));
      this.known = { keys, at: Date.now() };
    } catch (err) {
      // База не ответила — остаётся прежний список; следующая попытка не раньше, чем через KNOWN_TTL_MS.
      this.known = { ...this.known, at: Date.now() };
      this.log.warn(`Не удалось прочитать адреса серверов: ${(err as Error).message}`);
    }
  }

  /** Сервер удалили из панели: соединение его агента закрываем сразу, а не ждём, пока оно оборвётся само. */
  dropServer(serverId: string): void {
    const ws = this.active.get(serverId);
    if (ws) this.closeDeleted(ws, serverId);
  }

  /** Агенту говорим причину (её видно в его журнале на сервере) и закрываем соединение особым кодом. */
  private closeDeleted(ws: WebSocket, serverId: string): void {
    // Из списка убираем заранее: обработчик закрытия не должен писать «пропал со связи» про удалённый сервер.
    if (this.active.get(serverId) === ws) this.active.delete(serverId);
    this.sendError(ws, 'unknown-server', 'Сервер удалён из панели');
    ws.close(CLOSE_SERVER_DELETED, 'server deleted');
  }

  /**
   * Кто-то представился агентом, но не прошёл: чужой serverId или другой ключ — это важно видеть в Журнале.
   * Но не каждую попытку: запись — раз в час на сервер, `attempts` — сколько отказов было с прошлой записи
   * (вместе с этим).
   */
  private async authFailed(code: string, serverId: string, serverName: string | null): Promise<void> {
    const now = Date.now();
    let key = serverId;
    if (!this.authFailures.has(key) && this.authFailures.size >= AUTH_FAILED_TRACK_MAX) {
      for (const [k, v] of this.authFailures)
        if (now - v.loggedAt >= AUTH_FAILED_LOG_EVERY_MS) this.authFailures.delete(k);
      if (this.authFailures.size >= AUTH_FAILED_TRACK_MAX) key = AUTH_FAILED_OTHERS;
    }
    const last = this.authFailures.get(key);
    if (last && now - last.loggedAt < AUTH_FAILED_LOG_EVERY_MS) {
      last.skipped += 1;
      return;
    }
    this.authFailures.set(key, { loggedAt: now, skipped: 0 });
    await this.audit
      .record({
        action: 'server.agent.auth_failed',
        result: 'denied',
        severity: 'warn',
        source: 'auto',
        actor: { type: 'anonymous', id: null, display: 'агент' },
        target: { type: 'server', id: serverId, display: serverName ?? serverId },
        metadata: { code, attempts: (last?.skipped ?? 0) + 1 },
      })
      .catch(() => undefined);
  }

  /** Отказ во входе (чужой сервер, другой ключ, неверная подпись): причина агенту и разрыв. */
  private fail(ws: WebSocket, code: AgentErrorPayload['code'], message: string): void {
    this.sendError(ws, code, message);
    closePreAuth(ws, 4403, code);
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
