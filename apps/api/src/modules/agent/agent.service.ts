import { HttpStatus, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  AGENT_HEARTBEAT_SECONDS,
  type AgentEnrollRequest,
  type AgentEnrollResponse,
  type AgentMetrics,
  type AgentWelcome,
} from '@nodeservice/shared';

import { CryptoService } from '../../common/crypto/crypto.service.js';
import { problem } from '../../common/filters/problem-details.filter.js';
import type { Env } from '../../config/env.schema.js';
import type { ServerRow } from '../../infra/db/schema/index.js';
import type { AuditActor } from '../audit/audit.context.js';
import { AuditService } from '../audit/audit.service.js';
import { ServersRepository } from '../servers/servers.repository.js';
import { AutochecksStore } from '../settings/autochecks.store.js';
import { VmWriterService } from './vm.service.js';

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
    return { serverId: server.id, serverName: server.name, wsUrl: this.wsUrl() };
  }

  /** ws(s)-адрес шлюза из PUBLIC_URL. */
  wsUrl(): string {
    const base = this.config.get('PUBLIC_URL');
    return `${base.replace(/^http/, 'ws')}/api/agent/v1/ws`;
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
    };
  }

  /** `reason` — почему агент «вышел на связь» без нового подключения (в Журнал, словами). */
  async markOnline(server: ServerRow, version: string, reason?: string): Promise<void> {
    const was = server.agentStatus;
    await this.servers.update(server.id, {
      agentStatus: 'online',
      agentVersion: version,
      agentLastSeenAt: new Date(),
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
    const row = await this.servers.update(serverId, { agentLastSeenAt: new Date() });
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
}
