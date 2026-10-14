import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { REMNAWAVE_PROBLEM, type RemnawaveTopology } from '@nodeservice/shared';
import { desc, sql } from 'drizzle-orm';

import { problem } from '../../common/filters/problem-details.filter.js';
import { DB, type Db } from '../../infra/db/db.module.js';
import { remnawaveConfigSnapshots } from '../../infra/db/schema/index.js';
import { HostAddressesService } from './host-addresses.service.js';
import { REMNAWAVE_CLIENT, type RemnawaveClient } from './remnawave-client.js';
import {
  diffTopologySnapshots,
  safeTopologySnapshot,
  topologySnapshotHash,
} from './remnawave-config-snapshot.js';
import { RemnawaveSettingsStore } from './remnawave-settings.store.js';
import { buildRemnawaveTopology, topologyAddresses } from './remnawave-topology.logic.js';

const CACHE_MS = process.env.NODE_ENV === 'test' ? 0 : 60_000;

@Injectable()
export class RemnawaveTopologyService {
  private cache: { at: number; value: RemnawaveTopology } | null = null;

  constructor(
    private readonly store: RemnawaveSettingsStore,
    @Inject(REMNAWAVE_CLIENT) private readonly client: RemnawaveClient,
    private readonly addresses: HostAddressesService,
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
    // Принудительное чтение (сценарии) заново спрашивает адреса, на которые недавно не ответил DNS.
    const resolvedAddresses = await this.addresses.resolveAddresses(topologyAddresses(source), {
      retryFailed: force,
    });
    const value = buildRemnawaveTopology(source, resolvedAddresses);
    value.configSnapshot = await this.captureConfigSnapshot(value);
    addRuntime(value);
    this.cache = { at: Date.now(), value };
    return value;
  }

  private async captureConfigSnapshot(
    topology: RemnawaveTopology,
  ): Promise<RemnawaveTopology['configSnapshot']> {
    const snapshot = safeTopologySnapshot(topology);
    const hash = topologySnapshotHash(snapshot);
    const recent = await this.db
      .select()
      .from(remnawaveConfigSnapshots)
      .orderBy(desc(remnawaveConfigSnapshots.capturedAt))
      .limit(2);
    const latest = recent[0];
    if (latest?.hash === hash)
      return {
        hash,
        capturedAt: latest.capturedAt.toISOString(),
        previousAt: recent[1]?.capturedAt.toISOString() ?? null,
        changes: latest.changes,
      };
    const changes = diffTopologySnapshots(
      (latest?.snapshot as Parameters<typeof diffTopologySnapshots>[0]) ?? null,
      snapshot,
    );
    const [created] = await this.db
      .insert(remnawaveConfigSnapshots)
      .values({ hash, snapshot, changes })
      .returning();
    if (!created) return null;
    await this.db.execute(sql`
      delete from remnawave_config_snapshots
      where id not in (
        select id from remnawave_config_snapshots order by captured_at desc limit 30
      )
    `);
    return {
      hash,
      capturedAt: created.capturedAt.toISOString(),
      previousAt: latest?.capturedAt.toISOString() ?? null,
      changes,
    };
  }

  /** Та же безопасная проекция для Ассистента: конфиги и секреты в неё не входят изначально. */
  async forAssistant(): Promise<Record<string, unknown>> {
    try {
      const topology = await this.get();
      return {
        ...topology,
        hosts: topology.hosts.slice(0, 100),
        nodes: topology.nodes.slice(0, 100),
        routes: topology.routes.slice(0, 150),
        paths: topology.paths.slice(0, 250),
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
}

/** Состояние звеньев пути по данным Remnawave: входная и выходная ноды на связи или нет. */
function addRuntime(topology: RemnawaveTopology): void {
  const nodeById = new Map(topology.nodes.map((node) => [node.id, node]));
  for (const path of topology.paths) {
    const entry = path.entryNodeUuid ? nodeById.get(path.entryNodeUuid) : undefined;
    const exit = path.exitNodeUuid ? nodeById.get(path.exitNodeUuid) : undefined;
    for (const segment of path.segments) {
      if (segment.kind === 'inbound_entry' && entry)
        segment.runtime = {
          status: entry.status,
          checkedAt: topology.generatedAt,
          source: 'remnawave',
          label: 'Входная нода',
          detail: entry.connected ? 'Remnawave видит ноду на связи.' : 'Remnawave не видит ноду на связи.',
        };
      else if (segment.kind === 'outbound_exit' && exit)
        segment.runtime = {
          status: exit.status,
          checkedAt: topology.generatedAt,
          source: 'remnawave',
          label: 'Выходная нода',
          detail: exit.connected
            ? `На связи · ${exit.usersOnline ?? 0} онлайн`
            : 'Remnawave не видит ноду на связи.',
        };
    }
  }
}
