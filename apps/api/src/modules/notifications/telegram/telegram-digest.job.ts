import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';

import { TelegramService } from './telegram.service.js';

/** Раз в минуту: закончились тихие часы — отправить накопленную сводку. */
@Injectable()
export class TelegramDigestJob {
  private readonly log = new Logger(TelegramDigestJob.name);

  constructor(private readonly telegram: TelegramService) {}

  @Interval(60_000)
  async tick(): Promise<void> {
    if (process.env.NODE_ENV === 'test') return;
    await this.telegram
      .flushDigest()
      .catch((err) => this.log.warn(`Сводка Telegram после тихих часов: ${(err as Error).message}`));
  }
}
