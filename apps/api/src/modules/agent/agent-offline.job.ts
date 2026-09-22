import { Injectable } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';

import { ServersRepository } from '../servers/servers.repository.js';
import { AutochecksStore } from '../settings/autochecks.store.js';
import { AgentService } from './agent.service.js';

/**
 * Автопроверка «агент не в сети»: heartbeat молчит дольше порога из настроек → offline (+ Журнал).
 * Тик каждые 10 с; тумблер и порог — Настройки → Автопроверки.
 */
@Injectable()
export class AgentOfflineJob {
  private busy = false;

  constructor(
    private readonly servers: ServersRepository,
    private readonly agents: AgentService,
    private readonly autochecks: AutochecksStore,
  ) {}

  @Interval(10_000)
  async tick(): Promise<void> {
    // В e2e джобы не тикают сами — тесты управляют состоянием напрямую (детерминизм).
    if (process.env.NODE_ENV === 'test') return;
    if (this.busy) return;
    this.busy = true;
    try {
      const cfg = await this.autochecks.get();
      if (!cfg.agentOfflineEnabled) return;
      const deadline = Date.now() - cfg.agentOfflineAfterSeconds * 1_000;
      for (const row of await this.servers.list()) {
        if (row.agentStatus !== 'online') continue;
        if (!row.agentLastSeenAt || row.agentLastSeenAt.getTime() < deadline)
          await this.agents.markOffline(row, `heartbeat молчит дольше ${cfg.agentOfflineAfterSeconds} с`);
      }
    } finally {
      this.busy = false;
    }
  }
}
