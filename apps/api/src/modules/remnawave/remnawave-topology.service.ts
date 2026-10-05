import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import {
  blockCheckResultSchema,
  REMNAWAVE_PROBLEM,
  type RemnawaveServerReadiness,
  type RemnawaveTopology,
  type Server,
} from '@nodeservice/shared';
import { desc, eq } from 'drizzle-orm';

import { problem } from '../../common/filters/problem-details.filter.js';
import { DB, type Db } from '../../infra/db/db.module.js';
import { serverChecks } from '../../infra/db/schema/index.js';
import { BillingService } from '../billing/billing.service.js';
import { billingItemBelongsToServer, serverBillingAliases } from '../billing/server-billing-identity.js';
import { ServersService } from '../servers/servers.service.js';
import { NodeLinkService } from './node-link.service.js';
import { REMNAWAVE_CLIENT, type RemnawaveClient, type RemnawaveTopologySource } from './remnawave-client.js';
import { RemnawaveSettingsStore } from './remnawave-settings.store.js';
import { buildRemnawaveTopology, topologyAddresses } from './remnawave-topology.logic.js';

const CACHE_MS = process.env.NODE_ENV === 'test' ? 0 : 60_000;

@Injectable()
export class RemnawaveTopologyService {
  private cache: { at: number; value: RemnawaveTopology } | null = null;

  constructor(
    private readonly store: RemnawaveSettingsStore,
    @Inject(REMNAWAVE_CLIENT) private readonly client: RemnawaveClient,
    private readonly servers: ServersService,
    private readonly links: NodeLinkService,
    private readonly billing: BillingService,
    @Inject(DB) private readonly db: Db,
  ) {}

  async get(force = false): Promise<RemnawaveTopology> {
    if (!force && this.cache && Date.now() - this.cache.at < CACHE_MS) return this.cache.value;
    const creds = await this.store.credentials();
    if (!creds)
      throw problem(HttpStatus.CONFLICT, {
        type: REMNAWAVE_PROBLEM.notConnected,
        detail: 'Remnawave не подключена.',
      });
    const source = await this.client.readTopology(creds.domain, creds.apiKey);
    const fleet = await this.servers.list();
    const [linked, resolvedAddresses] = await Promise.all([
      this.linkedServers(source, fleet),
      this.links.resolveAddresses(topologyAddresses(source)),
    ]);
    const value = buildRemnawaveTopology(source, linked, resolvedAddresses);
    await this.addRuntime(value, fleet);
    this.cache = { at: Date.now(), value };
    return value;
  }

  /** Та же безопасная проекция для Джарвиса: конфиги и секреты в неё не входят изначально. */
  async forAssistant(): Promise<Record<string, unknown>> {
    try {
      const topology = await this.get();
      return {
        ...topology,
        hosts: topology.hosts.slice(0, 100),
        nodes: topology.nodes.slice(0, 100),
        routes: topology.routes.slice(0, 150),
        paths: topology.paths.slice(0, 250),
        readiness: topology.readiness.slice(0, 100),
        profiles: topology.profiles.slice(0, 50),
        issues: topology.issues.slice(0, 100),
        safety:
          'Только чтение. Пользователи, UUID клиентов, ключи, токены и полные Xray-конфигурации в карту не включаются.',
      };
    } catch (error) {
      return {
        error: error instanceof Error ? error.message : 'Не удалось построить карту Remnawave.',
      };
    }
  }

  clear(): void {
    this.cache = null;
  }

  private async linkedServers(
    source: RemnawaveTopologySource,
    fleet: Server[],
  ): Promise<Map<string, readonly string[]>> {
    const nodes = source.nodes.map((node) => ({
      uuid: typeof node.uuid === 'string' ? node.uuid : '',
      name: typeof node.name === 'string' ? node.name : '',
      address: typeof node.address === 'string' ? node.address : '',
    }));
    const links = await this.links.resolve(fleet, nodes);
    return new Map(nodes.map((node) => [node.uuid, links.serverIdsOf(node.uuid)]));
  }

  private async addRuntime(topology: RemnawaveTopology, fleet: Server[]): Promise<void> {
    const [checks, billing] = await Promise.all([
      this.db
        .selectDistinctOn([serverChecks.serverId])
        .from(serverChecks)
        .where(eq(serverChecks.check, 'russia_access'))
        .orderBy(serverChecks.serverId, desc(serverChecks.startedAt)),
      this.billing.list(false).catch(() => ({ items: [] })),
    ]);
    const serverById = new Map(fleet.map((server) => [server.id, server]));
    const checkByServer = new Map(checks.map((check) => [check.serverId, check]));
    const nodeById = new Map(topology.nodes.map((node) => [node.id, node]));
    const routeById = new Map(topology.routes.map((route) => [route.id, route]));

    const component = (server: Server | undefined, key: 'remnanode' | 'selfsteal' | 'psiphon') =>
      server?.inventory?.components?.find((item) => item.key === key);
    const componentStatus = (item: ReturnType<typeof component>) =>
      !item
        ? ('unknown' as const)
        : !item.installed
          ? ('error' as const)
          : item.running === false
            ? ('warning' as const)
            : ('ok' as const);
    const checkResult = (serverId: string | undefined) => {
      const row = serverId ? checkByServer.get(serverId) : undefined;
      if (!row?.output) return null;
      try {
        const parsed = blockCheckResultSchema.safeParse(JSON.parse(row.output));
        return parsed.success ? { row, result: parsed.data } : null;
      } catch {
        return null;
      }
    };
    const vpnStatus = (verdict: string | undefined) =>
      verdict === 'ok'
        ? ('ok' as const)
        : verdict === 'mixed'
          ? ('warning' as const)
          : verdict === 'regional_block' || verdict === 'failed_everywhere'
            ? ('error' as const)
            : ('unknown' as const);

    for (const path of topology.paths) {
      const entry = path.entryNodeUuid ? nodeById.get(path.entryNodeUuid) : undefined;
      const exit = path.exitNodeUuid ? nodeById.get(path.exitNodeUuid) : undefined;
      const serverId = entry?.serverIds[0];
      const server = serverId ? serverById.get(serverId) : undefined;
      const route = path.routeId ? routeById.get(path.routeId) : undefined;
      const measured = checkResult(serverId);
      for (const segment of path.segments) {
        if (segment.kind === 'host_inbound') {
          const item = component(server, 'selfsteal');
          if (item && server?.inventory)
            segment.runtime = {
              status: componentStatus(item),
              checkedAt: server.inventory.at,
              source: 'inventory',
              label: 'Selfsteal',
              detail: item.detail,
            };
        } else if (segment.kind === 'inbound_entry' && entry) {
          const item = component(server, 'remnanode');
          segment.runtime = {
            status: item ? componentStatus(item) : entry.status,
            checkedAt: server?.inventory?.at ?? topology.generatedAt,
            source: item ? 'inventory' : 'remnawave',
            label: 'Входная нода',
            detail:
              item?.detail ??
              (entry.connected ? 'Remnawave видит ноду на связи.' : 'Remnawave не видит ноду на связи.'),
          };
        } else if (
          segment.kind === 'entry_outbound' &&
          /psiphon/i.test(`${route?.targetLabel} ${route?.outboundTag}`)
        ) {
          const item = component(server, 'psiphon');
          if (item && server?.inventory)
            segment.runtime = {
              status: componentStatus(item),
              checkedAt: server.inventory.at,
              source: 'inventory',
              label: 'Psiphon',
              detail: item.detail,
            };
        } else if (segment.kind === 'outbound_exit' && exit) {
          segment.runtime = {
            status: exit.status,
            checkedAt: topology.generatedAt,
            source: 'remnawave',
            label: 'Выходная нода',
            detail: exit.connected
              ? `На связи · ${exit.usersOnline ?? 0} онлайн`
              : 'Remnawave не видит ноду на связи.',
          };
        } else if (segment.kind === 'exit_internet' && measured) {
          const result = measured.result;
          const count = [...(result.vpnProbes ?? []), ...(result.vpnForeign ?? [])];
          segment.runtime = {
            status: vpnStatus(result.vpnVerdict),
            checkedAt: measured.row.finishedAt?.toISOString() ?? measured.row.startedAt.toISOString(),
            source: 'vpn_probe',
            label: 'Настоящий VPN-трафик',
            detail:
              result.vpnUnchecked ??
              (count.length
                ? `${count.filter((probe) => probe.ok).length} из ${count.length} проб прошли.`
                : 'Проба ещё не выполнялась.'),
          };
        }
      }
    }

    const rank = { ok: 0, unknown: 1, warning: 2, error: 3 } as const;
    topology.readiness = fleet.map((server): RemnawaveServerReadiness => {
      const linkedNodes = topology.nodes.filter((node) => node.serverIds.includes(server.id));
      const paths = topology.paths.filter(
        (path) => path.entryNodeUuid && linkedNodes.some((node) => node.id === path.entryNodeUuid),
      );
      const inventoryAt = server.inventory?.at ?? null;
      const item = (
        key: RemnawaveServerReadiness['items'][number]['key'],
        label: string,
        status: RemnawaveServerReadiness['status'],
        detail: string,
        checkedAt: string | null = null,
      ) => ({ key, label, status, detail, checkedAt });
      const billingItems = billing.items.filter((payment) =>
        billingItemBelongsToServer({
          ...payment,
          provider: null,
          serverId: server.id,
          aliases: serverBillingAliases(server),
        }),
      );
      const due = billingItems.find(
        (payment) => payment.dueState === 'overdue' || payment.dueState === 'today',
      );
      const remnanode = component(server, 'remnanode');
      const psiphon = component(server, 'psiphon');
      const selfsteal = component(server, 'selfsteal');
      const items = [
        item(
          'agent',
          'Агент',
          server.agentStatus === 'online' ? 'ok' : 'error',
          server.agentStatus === 'online'
            ? `На связи · ${server.agentVersion ?? 'версия не указана'}`
            : 'Агент не на связи.',
          server.agentLastSeenAt,
        ),
        item(
          'remnanode',
          'Remnanode',
          componentStatus(remnanode),
          remnanode?.detail ?? 'Нет свежего снимка установки.',
          inventoryAt,
        ),
        item(
          'psiphon',
          'Psiphon',
          componentStatus(psiphon),
          psiphon?.detail ?? 'Нет свежего снимка установки.',
          inventoryAt,
        ),
        item(
          'selfsteal',
          'Selfsteal',
          componentStatus(selfsteal),
          selfsteal?.detail ?? 'Нет свежего снимка установки.',
          inventoryAt,
        ),
        item(
          'ports',
          'Порты',
          server.drift.some((drift) => drift.kind === 'port_not_listening')
            ? 'error'
            : server.inventory
              ? 'ok'
              : 'unknown',
          server.drift.find((drift) => drift.kind === 'port_not_listening')?.detail ??
            (server.inventory ? 'Ожидаемые порты слушаются.' : 'Инвентарь ещё не собран.'),
          inventoryAt,
        ),
        item(
          'profile',
          'Профиль и хост',
          paths.length ? 'ok' : 'warning',
          paths.length
            ? `Найдено путей: ${paths.length}.`
            : 'Для сервера не найден клиентский путь Remnawave.',
          topology.generatedAt,
        ),
        item(
          'entry',
          'Входная нода',
          linkedNodes.some((node) => node.status === 'ok') ? 'ok' : linkedNodes.length ? 'error' : 'unknown',
          linkedNodes.length
            ? linkedNodes.map((node) => node.name).join(', ')
            : 'Нода Remnawave не связана с сервером.',
          topology.generatedAt,
        ),
        item(
          'exit',
          'Выход',
          paths.some((path) => path.destination !== 'unknown' && path.status !== 'error')
            ? 'ok'
            : paths.length
              ? 'error'
              : 'unknown',
          paths.length
            ? `${paths.filter((path) => path.destination !== 'unknown').length} маршрутов с понятным назначением.`
            : 'Маршрут не найден.',
          topology.generatedAt,
        ),
        item(
          'billing',
          'Оплата',
          due ? 'error' : billingItems.length ? 'ok' : 'unknown',
          due
            ? `${due.title}: срок оплаты прошёл.`
            : billingItems.length
              ? `Активных оплат: ${billingItems.length}.`
              : 'Связанная оплата не найдена.',
        ),
      ];
      const status = items.reduce<RemnawaveServerReadiness['status']>(
        (worst, current) => (rank[current.status] > rank[worst] ? current.status : worst),
        'ok',
      );
      return { serverId: server.id, serverName: server.name, status, items };
    });
  }
}
