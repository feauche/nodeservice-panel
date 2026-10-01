import { Injectable } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';

import { TelegramService } from './telegram.service.js';

/** Повторяет адресные доставки, которые не подтвердил Telegram, в том числе после рестарта панели. */
@Injectable()
export class TelegramOutboxJob {
  constructor(private readonly telegram: TelegramService) {}

  @Interval(60_000)
  async run(): Promise<void> {
    await this.telegram.retryOutbox().catch(() => undefined);
  }
}
