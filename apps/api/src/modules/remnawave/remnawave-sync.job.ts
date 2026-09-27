import { Injectable } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { REMNAWAVE_SYNC_INTERVAL_MIN } from '@nodeservice/shared';

import { RemnawaveService } from './remnawave.service.js';

/** Периодическая перепроверка Remnawave (сводка, ноды, сертификат панели), тихо — без записи в Журнал на каждый тик. */
@Injectable()
export class RemnawaveSyncJob {
  private busy = false;

  constructor(private readonly remnawave: RemnawaveService) {}

  @Interval(REMNAWAVE_SYNC_INTERVAL_MIN * 60_000)
  async tick(): Promise<void> {
    if (process.env.NODE_ENV === 'test') return;
    if (this.busy) return;
    this.busy = true;
    try {
      await this.remnawave.syncQuiet();
    } finally {
      this.busy = false;
    }
  }
}
