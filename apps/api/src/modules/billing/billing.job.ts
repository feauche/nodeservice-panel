import { Injectable } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';

import { BillingService } from './billing.service.js';

/** Раз в минуту: автоплатежи, напоминания об оплате (срок наступил — сообщение в ту же минуту), досчёт рублей. */
@Injectable()
export class BillingJob {
  private running = false;

  constructor(private readonly billing: BillingService) {}

  @Interval(60_000)
  async tick(): Promise<void> {
    if (process.env.NODE_ENV === 'test' || this.running) return;
    this.running = true;
    try {
      await this.billing.tick();
    } finally {
      this.running = false;
    }
  }
}
