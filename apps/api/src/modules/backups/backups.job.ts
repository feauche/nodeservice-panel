import { Injectable } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';

import { BackupsService } from './backups.service.js';

/** Раз в минуту: не пора ли сделать копию по расписанию (время — по часовому поясу панели). */
@Injectable()
export class BackupsJob {
  constructor(private readonly backups: BackupsService) {}

  @Interval(60_000)
  async tick(): Promise<void> {
    if (process.env.NODE_ENV === 'test') return;
    await this.backups.tick().catch(() => undefined);
  }
}
