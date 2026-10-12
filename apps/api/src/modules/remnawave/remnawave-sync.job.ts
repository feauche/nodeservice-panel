import { Injectable } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { MonitoringStore } from '../settings/monitoring.store.js';

import { RemnawaveService } from './remnawave.service.js';

/** Периодическая перепроверка Remnawave (сводка, ноды, сертификат панели), тихо — без записи в Журнал на каждый тик. */
@Injectable()
export class RemnawaveSyncJob {
  private busy = false;
  private lastAt = 0;

  constructor(private readonly remnawave: RemnawaveService, private readonly settings: MonitoringStore) {}

  @Interval(10_000)
  async tick(): Promise<void> {
    if (process.env.NODE_ENV === 'test') return;
    if (this.busy) return;
    this.busy = true;
    try {
      const cfg = await this.settings.get();
      if (!cfg.enabled || Date.now() < this.lastAt + cfg.pollSeconds * 1000) return;
      await this.remnawave.syncQuiet(cfg.apiTimeoutSeconds * 1000);
      this.lastAt = Date.now();
    } finally {
      this.busy = false;
    }
  }
}
