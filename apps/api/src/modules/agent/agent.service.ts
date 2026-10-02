import { createPublicKey, verify as edVerify } from 'node:crypto';
import { HttpStatus, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  AGENT_HEARTBEAT_SECONDS,
  type AgentEnrollRequest,
  type AgentEnrollResponse,
  type AgentMetrics,
  type AgentPulseRequest,
  type AgentPulseResponse,
  type AgentWelcome,
  agentPulsePayloadSchema,
  agentPulseSigningText,
} from '@nodeservice/shared';

import { CryptoService } from '../../common/crypto/crypto.service.js';
import { problem } from '../../common/filters/problem-details.filter.js';
import type { Env } from '../../config/env.schema.js';
import type { ServerRow } from '../../infra/db/schema/index.js';
import type { AuditActor } from '../audit/audit.context.js';
import { AuditService } from '../audit/audit.service.js';
import { ServersRepository } from '../servers/servers.repository.js';
import { AutochecksStore } from '../settings/autochecks.store.js';
import { configuredAgentWsUrls } from './agent-urls.js';
import { VmWriterService } from './vm.service.js';

const PULSE_CLOCK_SKEW_MS = 2 * 60_000;
const PULSE_REPLAY_MAX = 10_000;
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

export interface AgentConnection {
  transport: 'websocket' | 'https';
  route?: string;
  fallback?: boolean;
}

/** Актор записей Журнала от имени агента: системный, но с понятной подписью. */
const agentActor = (serverName: string, serverId: string): AuditActor => ({
  type: 'system',
  id: serverId,
  display: `агент ${serverName}`,
});

/**
 * Жизненный цикл агента: энроллмент по одноразовому токену (TOFU-пиннинг ключа),
 * online/offline по heartbeat, приём метрик → VictoriaMetrics. Все переходы — в Журнал.
 */
@Injectable()
export class AgentService {
  /** Серверы, которым прямо сейчас возвращаем «в сети»: сигнал и метрика приходят почти разом, запись в Журнале — одна. */
  private readonly reviving = new Set<string>();
  /** Недавние id HTTPS pulse: подпись нельзя повторить в пределах допустимого окна времени. */
  private readonly pulseIds = new Map<string, number>();

  constructor(
    private readonly servers: ServersRepository,
    private readonly crypto: CryptoService,
    private readonly audit: AuditService,
    private readonly autochecks: AutochecksStore,
    private readonly vm: VmWriterService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  /** Обмен одноразового токена на привязку ключа агента. Причину отказа не детализируем — токен секретный. */
  async enroll(req: AgentEnrollRequest): Promise<AgentEnrollResponse> {
    const badToken = () =>
      problem(HttpStatus.BAD_REQUEST, {
        detail: 'Токен не подошёл: просрочен, отозван или уже использован. Выпусти новый в карточке сервера.',
      });
    const row = await this.servers.findEnrollmentByHash(this.crypto.sha256Hex(req.token));
    if (!row || row.revokedAt || row.usedAt || row.expiresAt.getTime() < Date.now()) throw badToken();
    const server = await this.servers.findById(row.serverId);
    if (!server) throw badToken();

    await this.servers.markEnrollmentUsed(row.id);
    const rebind = server.agentPubkey !== null && server.agentPubkey !== req.pubkey;
    await this.servers.update(server.id, {
      agentPubkey: req.pubkey,
      agentVersion: req.version,
      agentEnrolledAt: new Date(),
      agentStatus: server.agentStatus === 'online' ? 'online' : 'pending',
      agentTransport: null,
      agentRoute: null,
      agentRouteFallback: null,
    });
    await this.audit.record({
      action: 'server.agent.enrolled',
      actor: agentActor(server.name, server.id),
      source: 'auto',
      target: { type: 'server', id: server.id, display: server.name },
      metadata: {
        version: req.version,
        ...(req.hostname ? { hostname: req.hostname } : {}),
        ...(rebind ? { rebound: true } : {}),
      },
    });
    const wsUrls = this.wsUrls();
    return { serverId: server.id, serverName: server.name, wsUrl: wsUrls[0] as string, wsUrls };
  }

  /** Первый ws(s)-адрес шлюза для старых агентов. */
  wsUrl(): string {
    return this.wsUrls()[0] as string;
  }

  /** Основной и запасные маршруты; обычный адрес панели всегда остаётся последним резервом. */
  wsUrls(): string[] {
    return configuredAgentWsUrls(this.config);
  }

  async findServer(id: string): Promise<ServerRow | undefined> {
    return this.servers.findById(id);
  }

  async welcomeFor(server: ServerRow): Promise<AgentWelcome> {
    const cfg = await this.autochecks.get();
    return {
      serverName: server.name,
      heartbeatSeconds: AGENT_HEARTBEAT_SECONDS,
      metricsSeconds: cfg.metricsEnabled ? cfg.metricsIntervalSeconds : 0,
      wsUrls: this.wsUrls(),
    };
  }

  /**
   * Запасной HTTPS-канал. Подпись покрывает точную строку payload, id и время; короткое окно и кэш id
   * не дают повторить перехваченный запрос. Ответ возвращает те же интервалы и маршруты, что WebSocket.
   */
  async pulse(req: AgentPulseRequest): Promise<AgentPulseResponse> {
    const denied = () =>
      problem(HttpStatus.UNAUTHORIZED, { detail: 'Подпись или срок запроса агента не подошли.' });
    const sentAt = Date.parse(req.ts);
    const now = Date.now();
    if (!Number.isFinite(sentAt) || Math.abs(now - sentAt) > PULSE_CLOCK_SKEW_MS) throw denied();
    this.expirePulseIds(now);
    if (this.pulseIds.has(req.id)) throw denied();

    let server = await this.servers.findById(req.serverId);
    if (!server?.agentPubkey) throw denied();
    let key: ReturnType<typeof createPublicKey>;
    try {
      key = createPublicKey({
        key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(server.agentPubkey, 'base64')]),
        format: 'der',
        type: 'spki',
      });
    } catch {
      throw denied();
    }
    const ok = edVerify(
      null,
      Buffer.from(agentPulseSigningText(req)),
      key,
      Buffer.from(req.signature, 'base64'),
    );
    if (!ok) throw denied();

    let payload: unknown;
    try {
      payload = JSON.parse(req.payload);
    } catch {
      throw problem(HttpStatus.BAD_REQUEST, { detail: 'Payload агента не является JSON.' });
    }
    const parsed = agentPulsePayloadSchema.safeParse(payload);
    if (!parsed.success)
      throw problem(HttpStatus.BAD_REQUEST, { detail: 'Payload агента не соответствует протоколу.' });

    this.pulseIds.set(req.id, now + PULSE_CLOCK_SKEW_MS);
    if (parsed.data.route)
      server = await this.syncConnection(server, { transport: 'https', route: parsed.data.route });
    const alive = parsed.data.metrics
      ? await this.handleMetrics(server, req.version, parsed.data.metrics)
      : await this.touch(server.id, req.version);
    if (!alive) throw denied();
    return this.welcomeFor(server);
  }

  private expirePulseIds(now: number): void {
    for (const [id, expiresAt] of this.pulseIds) if (expiresAt <= now) this.pulseIds.delete(id);
    while (this.pulseIds.size >= PULSE_REPLAY_MAX) {
      const oldest = this.pulseIds.keys().next().value;
      if (typeof oldest !== 'string') break;
      this.pulseIds.delete(oldest);
    }
  }

  /** `reason` — почему агент «вышел на связь» без нового подключения (в Журнал, словами). */
  async markOnline(
    server: ServerRow,
    version: string,
    reason?: string,
    connection?: AgentConnection,
  ): Promise<void> {
    const was = server.agentStatus;
    await this.servers.update(server.id, {
      agentStatus: 'online',
      agentVersion: version,
      agentLastSeenAt: new Date(),
      ...(connection ? this.connectionPatch(connection) : {}),
    });
    if (was !== 'online')
      await this.audit.record({
        action: 'server.agent.online',
        actor: agentActor(server.name, server.id),
        source: 'auto',
        target: { type: 'server', id: server.id, display: server.name },
        metadata: { version, ...(reason ? { reason } : {}) },
      });
  }

  /**
   * Отметка живости на каждый сигнал и метрику. Соединение открыто и агент шлёт данные, а сервер числится
   * не «в сети» (джоба пометила его по затянувшейся паузе, связь при этом не рвалась) — возвращаем статус
   * сами: иначе «не в сети» висело бы до переподключения агента, то есть днями. Пока идёт установка,
   * статус ведёт она. false — сервера уже нет: шлюзу пора закрыть соединение.
   */
  async touch(serverId: string, version: string): Promise<boolean> {
    // Версия приходит с каждым heartbeat/pulse. После обновления процесс может остаться в статусе
    // online, поэтому ожидание перехода offline → online оставляло в карточке старую версию навсегда.
    const row = await this.servers.update(serverId, { agentLastSeenAt: new Date(), agentVersion: version });
    if (!row) return false;
    if (row.agentStatus === 'online' || row.agentStatus === 'installing' || this.reviving.has(serverId))
      return true;
    this.reviving.add(serverId);
    try {
      await this.markOnline(row, version, 'сигналы от агента возобновились, соединение не прерывалось');
    } finally {
      this.reviving.delete(serverId);
    }
    return true;
  }

  /**
   * `staleBefore` — для джобы: она решает по списку, прочитанному чуть раньше; если сигнал с тех пор
   * пришёл (позже этой отметки), агент на связи и помечать его нельзя.
   */
  async markOffline(server: ServerRow, reason: string, staleBefore?: Date): Promise<void> {
    const fresh = await this.servers.findById(server.id);
    if (fresh?.agentStatus !== 'online') return;
    if (staleBefore && fresh.agentLastSeenAt && fresh.agentLastSeenAt >= staleBefore) return;
    await this.servers.update(server.id, { agentStatus: 'offline' });
    await this.audit.record({
      action: 'server.agent.offline',
      severity: 'warn',
      actor: agentActor(server.name, server.id),
      source: 'auto',
      target: { type: 'server', id: server.id, display: server.name },
      metadata: { reason },
    });
  }

  /** false — сервера уже нет (см. touch): метрики не пишем. */
  async handleMetrics(server: ServerRow, version: string, metrics: AgentMetrics): Promise<boolean> {
    if (!(await this.touch(server.id, version))) return false;
    await this.vm.write(server.id, server.name, metrics);
    return true;
  }

  /** Снимок, который панель забрала у входящего агента. */
  async acceptPull(
    server: ServerRow,
    version: string,
    metrics: AgentMetrics | undefined,
    route: string,
  ): Promise<void> {
    const current = await this.syncConnection(server, {
      transport: 'https',
      route,
      fallback: false,
    });
    if (metrics) await this.handleMetrics(current, version, metrics);
    else await this.touch(current.id, version);
  }

  /** Записываем смену канала один раз; обычные сигналы не создают событий обновления сервера каждые 10 с. */
  private async syncConnection(server: ServerRow, connection: AgentConnection): Promise<ServerRow> {
    const patch = this.connectionPatch(connection);
    if (
      server.agentTransport === patch.agentTransport &&
      server.agentRoute === patch.agentRoute &&
      server.agentRouteFallback === patch.agentRouteFallback
    )
      return server;
    return (await this.servers.update(server.id, patch)) ?? server;
  }

  private connectionPatch(connection: AgentConnection) {
    const route = connection.route ?? null;
    return {
      agentTransport: connection.transport,
      agentRoute: route,
      agentRouteFallback: route ? (connection.fallback ?? route !== this.wsUrls()[0]) : null,
    } as const;
  }
}
