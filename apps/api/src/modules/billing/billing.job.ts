import { Injectable } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';

import { BillingService } from './billing.service.js';

/** Раз в 10 минут: автоплатежи, досчёт рублей по курсу, напоминания об оплате. */
@Injectable()
export class BillingJob {
  private running = false;

  constructor(private readonly billing: BillingService) {}

  @Interval(10 * 60_000)
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
