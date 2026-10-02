import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';

import type { ServerRow } from '../../infra/db/schema/index.js';
import { ServersRepository } from '../servers/servers.repository.js';
import { AutochecksStore } from '../settings/autochecks.store.js';
import { AgentService } from './agent.service.js';
import { AgentPullClient } from './agent-pull.client.js';

const CONCURRENCY = 20;
const WARN_EVERY_MS = 5 * 60_000;

/** Панель сама опрашивает новые агенты, как Remnawave опрашивает свои ноды. */
@Injectable()
export class AgentPullJob {
  private readonly log = new Logger(AgentPullJob.name);
  private readonly warnedAt = new Map<string, number>();
  private busy = false;

  constructor(
    private readonly servers: ServersRepository,
    private readonly client: AgentPullClient,
    private readonly agents: AgentService,
    private readonly autochecks: AutochecksStore,
  ) {}

  @Interval(10_000)
  async tick(): Promise<void> {
    if (process.env.NODE_ENV === 'test' || this.busy) return;
    this.busy = true;
    try {
      const cfg = await this.autochecks.get();
      const rows = (await this.servers.list()).filter(
        (row) => row.agentListenPort && row.agentAccessKeyEnc && row.agentTlsCert,
      );
      let cursor = 0;
      const worker = async () => {
        for (;;) {
          const row = rows[cursor++];
          if (!row) return;
          await this.poll(row, cfg.metricsEnabled);
        }
      };
      await Promise.all(Array.from({ length: Math.min(CONCURRENCY, rows.length) }, worker));
    } finally {
      this.busy = false;
    }
  }

  private async poll(row: ServerRow, metrics: boolean): Promise<void> {
    try {
      const snapshot = await this.client.snapshot(row, metrics);
      this.warnedAt.delete(row.id);
      const host = row.host.includes(':') ? `[${row.host}]` : row.host;
      await this.agents.acceptPull(
        row,
        snapshot.version,
        snapshot.metrics,
        `https://${host}:${row.agentListenPort}`,
      );
    } catch (err) {
      const now = Date.now();
      if (now - (this.warnedAt.get(row.id) ?? 0) < WARN_EVERY_MS) return;
      this.warnedAt.set(row.id, now);
      this.log.warn(
        `Агент «${row.name}» недоступен на порту ${row.agentListenPort}: ${(err as Error).message}`,
      );
    }
  }
}
