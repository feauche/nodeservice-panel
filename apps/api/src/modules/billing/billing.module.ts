import { Module } from '@nestjs/common';

import { BillingController } from './billing.controller.js';
import { BillingJob } from './billing.job.js';
import { BillingService } from './billing.service.js';
import { BillingRatesService } from './billing-rates.service.js';
import { BILLING_RATES_SOURCE, HttpCbrRatesSource } from './billing-rates.source.js';

/** Биллинг: оплаты серверов, аренды, доменов и сертификатов; курсы ЦБ; напоминания в Telegram. */
@Module({
  controllers: [BillingController],
  providers: [
    BillingService,
    BillingRatesService,
    BillingJob,
    { provide: BILLING_RATES_SOURCE, useClass: HttpCbrRatesSource },
  ],
  exports: [BillingService],
})
export class BillingModule {}
