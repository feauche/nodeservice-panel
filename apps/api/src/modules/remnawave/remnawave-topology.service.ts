import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { REMNAWAVE_PROBLEM, type RemnawaveTopology } from '@nodeservice/shared';

import { problem } from '../../common/filters/problem-details.filter.js';
import { ServersService } from '../servers/servers.service.js';
import { NodeLinkService } from './node-link.service.js';
import { REMNAWAVE_CLIENT, type RemnawaveClient, type RemnawaveTopologySource } from './remnawave-client.js';
import { RemnawaveSettingsStore } from './remnawave-settings.store.js';
import { buildRemnawaveTopology } from './remnawave-topology.logic.js';

const CACHE_MS = process.env.NODE_ENV === 'test' ? 0 : 60_000;

@Injectable()
export class RemnawaveTopologyService {
  private cache: { at: number; value: RemnawaveTopology } | null = null;

  constructor(
    private readonly store: RemnawaveSettingsStore,
    @Inject(REMNAWAVE_CLIENT) private readonly client: RemnawaveClient,
    private readonly servers: ServersService,
    private readonly links: NodeLinkService,
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
    const linked = await this.linkedServers(source);
    const value = buildRemnawaveTopology(source, linked);
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

  private async linkedServers(source: RemnawaveTopologySource): Promise<Map<string, readonly string[]>> {
    const nodes = source.nodes.map((node) => ({
      uuid: typeof node.uuid === 'string' ? node.uuid : '',
      name: typeof node.name === 'string' ? node.name : '',
      address: typeof node.address === 'string' ? node.address : '',
    }));
    const links = await this.links.resolve(await this.servers.list(), nodes);
    return new Map(nodes.map((node) => [node.uuid, links.serverIdsOf(node.uuid)]));
  }
}
