import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';

import { ServerCountryService } from './server-country.service.js';
import { ServersRepository } from './servers.repository.js';

const DAY_MS = 24 * 3_600_000;
const HOUR_MS = 3_600_000;

/**
 * Перепроверка страны серверов в режиме «автоматически»: раз в сутки; если проверка не удалась или показала
 * другую страну, повтор через час (чтобы подтверждение смены не растягивалось на сутки).
 */
@Injectable()
export class CountryRecheckJob {
  private readonly log = new Logger(CountryRecheckJob.name);
  private busy = false;

  constructor(
    private readonly servers: ServersRepository,
    private readonly country: ServerCountryService,
  ) {}

  @Interval(10 * 60_000)
  async tick(): Promise<void> {
    // В e2e джобы не тикают сами: тесты управляют состоянием напрямую.
    if (process.env.NODE_ENV === 'test') return;
    if (this.busy) return;
    this.busy = true;
    try {
      const now = Date.now();
      for (const row of await this.servers.list()) {
        if (row.countrySource !== 'auto') continue;
        const age = row.countryCheckedAt ? now - row.countryCheckedAt.getTime() : Number.POSITIVE_INFINITY;
        const soon = row.countryStatus === 'failed' || row.countryCandidateCount > 0;
        if (age < (soon ? HOUR_MS : DAY_MS)) continue;
        await this.country.detect(row.id, { scheduled: true }).catch((err) => {
          this.log.warn(
            `Перепроверка страны ${row.name}: ${err instanceof Error ? err.message : String(err)}`,
          );
        });
      }
    } finally {
      this.busy = false;
    }
  }
}
