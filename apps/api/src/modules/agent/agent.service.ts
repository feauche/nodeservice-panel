import { HttpStatus, Injectable, Logger } from '@nestjs/common';
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
  private readonly log = new Logger(AgentService.name);

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

  async markOnline(server: ServerRow, version: string): Promise<void> {
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
        metadata: { version },
      });
  }

  /** Лёгкая отметка живости на каждый heartbeat/метрику. */
  async touch(serverId: string): Promise<void> {
    await this.servers.update(serverId, { agentLastSeenAt: new Date() });
  }

  async markOffline(server: ServerRow, reason: string): Promise<void> {
    const fresh = await this.servers.findById(server.id);
    if (!fresh || fresh.agentStatus !== 'online') return;
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

  async handleMetrics(server: ServerRow, metrics: AgentMetrics): Promise<void> {
    await this.touch(server.id);
    await this.vm.write(server.id, server.name, metrics);
  }
}
