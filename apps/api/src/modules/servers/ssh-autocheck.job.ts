import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';

import { AutochecksStore } from '../settings/autochecks.store.js';
import { ServersRepository } from './servers.repository.js';
import { ServersService } from './servers.service.js';

/**
 * Автопроверка SSH (Настройки → Автопроверки): серверы без online-агента — по одному интервалу,
 * с online-агентом — по другому (живость и так даёт heartbeat, SSH — контроль доступа).
 * Тик раз в минуту решает, у кого интервал истёк; проверки последовательные.
 */
@Injectable()
export class SshAutocheckJob {
  private readonly log = new Logger(SshAutocheckJob.name);
  private busy = false;

  constructor(
    private readonly repo: ServersRepository,
    private readonly servers: ServersService,
    private readonly autochecks: AutochecksStore,
  ) {}

  @Interval(60_000)
  async tick(): Promise<void> {
    // В e2e джобы не тикают сами — тесты управляют состоянием напрямую (детерминизм).
    if (process.env.NODE_ENV === 'test') return;
    if (this.busy) return;
    this.busy = true;
    try {
      const cfg = await this.autochecks.get();
      const now = Date.now();
      for (const row of await this.repo.list()) {
        const withAgent = row.agentStatus === 'online';
        const enabled = withAgent ? cfg.sshAgentEnabled : cfg.sshEnabled;
        if (!enabled) continue;
        const intervalMs = (withAgent ? cfg.sshAgentIntervalMinutes : cfg.sshIntervalMinutes) * 60_000;
        // Небольшой допуск, чтобы минутный тик не «промахивался» мимо ровного интервала.
        const due = !row.lastSshCheckAt || now - row.lastSshCheckAt.getTime() >= intervalMs - 5_000;
        if (due) await this.servers.autocheck(row);
      }
    } catch (err) {
      this.log.warn(`Автопроверка SSH споткнулась: ${(err as Error).message}`);
    } finally {
      this.busy = false;
    }
  }
}
