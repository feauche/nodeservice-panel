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
const RETRY_AFTER_FAIL_MS = 30 * 60_000;

/** Курс на дату и момент, когда панель получила его у ЦБ. */
export interface DayRates {
  usd: number;
  eur: number;
  date: string;
  fetchedAt: Date;
}

/**
 * Курсы ЦБ РФ. Кэш по дням в таблице billing_rates: один запрос к ЦБ на дату. Если ЦБ недоступен —
 * последний известный курс не старше недели; иначе null (оплата запишется, рубли досчитает фоновая задача).
 */
@Injectable()
export class BillingRatesService {
  private readonly log = new Logger(BillingRatesService.name);
  private readonly inflight = new Map<string, Promise<DayRates | null>>();
  /**
   * Когда ЦБ последний раз не ответил за эту дату. cbr.ru часто не отвечает зарубежным серверам, а ждать его
   * при каждом расчёте — это десятки секунд на каждую оплату: повторяем не чаще раза в полчаса.
   */
  private readonly failedAt = new Map<string, number>();

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(BILLING_RATES_SOURCE) private readonly source: BillingRatesSource,
  ) {}

  /** Курсы на дату; `fetch: false` — только из кэша (для списков, чтобы не ждать ЦБ). */
  async ratesOn(at: Date, opts: { fetch?: boolean } = {}): Promise<DayRates | null> {
    const date = moscowDate(at);
    const [cached] = await this.db
      .select()
      .from(billingRates)
      .where(lte(billingRates.date, date))
      .orderBy(desc(billingRates.date))
      .limit(1);
    if (cached?.date === date) return cached;
    const recentlyFailed = Date.now() - (this.failedAt.get(date) ?? 0) < RETRY_AFTER_FAIL_MS;
    if (opts.fetch !== false && !recentlyFailed) {
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

  private async load(date: string): Promise<DayRates | null> {
    const r = await this.source.fetch(date).catch(() => null);
    if (!r) {
      this.failedAt.set(date, Date.now());
      this.log.warn(`Курс ЦБ на ${date} получить не удалось — следующая попытка через 30 минут`);
      return null;
    }
    this.failedAt.delete(date);
    // Кэшируем под запрошенной датой: на выходных ЦБ отдаёт курс пятницы/субботы — он и действует.
    const fetchedAt = new Date();
    await this.db
      .insert(billingRates)
      .values({ date, usd: r.usd, eur: r.eur, fetchedAt })
      .onConflictDoUpdate({
        target: billingRates.date,
        set: { usd: r.usd, eur: r.eur, fetchedAt },
      });
    return { usd: r.usd, eur: r.eur, date, fetchedAt };
  }

  /** Рублей за единицу валюты; для рублей 1; null — курса нет. */
  async rate(currency: BillingCurrency, at: Date, opts: { fetch?: boolean } = {}): Promise<number | null> {
    if (currency === 'RUB') return 1;
    const r = await this.ratesOn(at, opts);
    if (!r) return null;
    return currency === 'USD' ? r.usd : r.eur;
  }
}
