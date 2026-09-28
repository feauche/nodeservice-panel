import { Inject, Injectable, Logger } from '@nestjs/common';
import type { BillingCurrency } from '@nodeservice/shared';
import { desc, lte } from 'drizzle-orm';

import { DB, type Db } from '../../infra/db/db.module.js';
import { billingRates } from '../../infra/db/schema/index.js';
import { BILLING_RATES_SOURCE, type BillingRatesSource } from './billing-rates.source.js';

/** Дата по Москве (курс ЦБ устанавливается на московскую дату): YYYY-MM-DD. */
export const moscowDate = (at: Date): string =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Moscow' }).format(at);

/** Курс не старше недели считаем пригодным, если свежий не получить (выходные, сбой сети). */
const STALE_DAYS = 7;

/**
 * Курсы ЦБ РФ. Кэш по дням в таблице billing_rates: один запрос к ЦБ на дату. Если ЦБ недоступен —
 * последний известный курс не старше недели; иначе null (оплата запишется, рубли досчитает фоновая задача).
 */
@Injectable()
export class BillingRatesService {
  private readonly log = new Logger(BillingRatesService.name);
  private readonly inflight = new Map<string, Promise<{ usd: number; eur: number; date: string } | null>>();

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(BILLING_RATES_SOURCE) private readonly source: BillingRatesSource,
  ) {}

  /** Курсы на дату; `fetch: false` — только из кэша (для списков, чтобы не ждать ЦБ). */
  async ratesOn(
    at: Date,
    opts: { fetch?: boolean } = {},
  ): Promise<{ usd: number; eur: number; date: string } | null> {
    const date = moscowDate(at);
    const [cached] = await this.db
      .select()
      .from(billingRates)
      .where(lte(billingRates.date, date))
      .orderBy(desc(billingRates.date))
      .limit(1);
    if (cached?.date === date) return cached;
    if (opts.fetch !== false) {
      let p = this.inflight.get(date);
      if (!p) {
        p = this.load(date).finally(() => this.inflight.delete(date));
        this.inflight.set(date, p);
      }
      const fresh = await p;
      if (fresh) return fresh;
    }
    if (cached && (at.getTime() - new Date(`${cached.date}T00:00:00Z`).getTime()) / 86_400_000 <= STALE_DAYS)
      return cached;
    return null;
  }

  private async load(date: string): Promise<{ usd: number; eur: number; date: string } | null> {
    const r = await this.source.fetch(date).catch(() => null);
    if (!r) {
      this.log.warn(`Курс ЦБ на ${date} получить не удалось`);
      return null;
    }
    // Кэшируем под запрошенной датой: на выходных ЦБ отдаёт курс пятницы/субботы — он и действует.
    await this.db
      .insert(billingRates)
      .values({ date, usd: r.usd, eur: r.eur })
      .onConflictDoUpdate({
        target: billingRates.date,
        set: { usd: r.usd, eur: r.eur, fetchedAt: new Date() },
      });
    return { usd: r.usd, eur: r.eur, date };
  }

  /** Рублей за единицу валюты; для рублей 1; null — курса нет. */
  async rate(currency: BillingCurrency, at: Date, opts: { fetch?: boolean } = {}): Promise<number | null> {
    if (currency === 'RUB') return 1;
    const r = await this.ratesOn(at, opts);
    if (!r) return null;
    return currency === 'USD' ? r.usd : r.eur;
  }
}
