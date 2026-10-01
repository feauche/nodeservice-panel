import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import {
  BILLING_KIND_LABELS,
  BILLING_KINDS,
  BILLING_PROBLEM,
  type BillingCurrency,
  type BillingExtend,
  type BillingForecast,
  type BillingForecastItem,
  type BillingItem,
  type BillingItemUpsert,
  type BillingKind,
  type BillingPayment,
  type BillingStatPeriod,
  type BillingStats,
  type BillingSummary,
  type BillingTotal,
  billingPeriodLabel,
  formatMoney,
  formatRub,
} from '@nodeservice/shared';
import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, lt, lte, ne, sql } from 'drizzle-orm';
import { ClsService } from 'nestjs-cls';

import { problem } from '../../common/filters/problem-details.filter.js';
import { DB, type Db } from '../../infra/db/db.module.js';
import {
  type BillingItemRow,
  type BillingPaymentRow,
  billingItems,
  billingPayments,
  incidents,
  providers,
  servers,
} from '../../infra/db/schema/index.js';
import { SYSTEM_ACTOR } from '../audit/audit.context.js';
import { AuditService } from '../audit/audit.service.js';
import { CLS_USER } from '../auth/cls-keys.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { formatBillingMessage, formatBillingRichMessage } from './billing.format.js';
import {
  dueInWords,
  dueStateOf,
  extendTarget,
  localDate,
  localMidnight,
  occurrenceDates,
  occurrencesUntil,
  periodBounds,
  periodMs,
  timesPerYear,
  toRubMinor,
} from './billing.logic.js';
import { BillingRatesService } from './billing-rates.service.js';
import {
  buildPaymentWindow,
  PAYMENT_WINDOW_MS,
  type PaymentEntry,
  type PaymentWindow,
  SERVER_PAYMENT_KINDS,
} from './payment-window.js';

const DEFAULT_TZ = 'Europe/Moscow';
const DAY_MS = 86_400_000;
/** Кем записано продление, которое панель сделала сама по автоплатежу. */
const AUTO_CHARGE_ACTOR = 'Автоплатёж';

const validTz = (tz: string | undefined): string => {
  if (!tz) return DEFAULT_TZ;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return tz;
  } catch {
    return DEFAULT_TZ;
  }
};

const minor = (amount: number): number => Math.round(amount * 100);

/** Строка биллинга для Джарвиса и разбора инцидента. */
export interface BillingBrief {
  id: string;
  kind: string;
  title: string;
  provider: string | null;
  servers: string[];
  domain: string | null;
  amount: string;
  amountRub: string | null;
  period: string;
  paidUntil: string;
  due: string;
  state: string;
  autoCharge: boolean;
  note: string | null;
}

@Injectable()
export class BillingService {
  private readonly log = new Logger(BillingService.name);

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly rates: BillingRatesService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
    private readonly cls: ClsService,
  ) {}

  private actorDisplay(): string | null {
    const user = this.cls.isActive()
      ? this.cls.get<{ id: string; login: string } | undefined>(CLS_USER)
      : undefined;
    return user?.login ?? null;
  }

  private async knownServerIds(): Promise<Set<string>> {
    const rows = await this.db.select({ id: servers.id }).from(servers);
    return new Set(rows.map((r) => r.id));
  }

  async toDto(row: BillingItemRow, now = new Date(), known?: Set<string>): Promise<BillingItem> {
    const ids = known ?? (await this.knownServerIds());
    const rate = await this.rates.rate(row.currency, now, { fetch: false });
    return {
      id: row.id,
      kind: row.kind,
      title: row.title,
      providerId: row.providerId,
      serverIds: row.serverIds.filter((id) => ids.has(id)),
      domain: row.domain,
      amountMinor: row.amountMinor,
      currency: row.currency,
      periodUnit: row.periodUnit,
      periodCount: row.periodCount,
      paidUntil: row.paidUntil.toISOString(),
      autoCharge: row.autoCharge,
      remindDays: row.remindDays,
      note: row.note,
      archivedAt: row.archivedAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
      dueState: dueStateOf(row, now),
      amountRubTodayMinor: rate === null ? null : toRubMinor(row.amountMinor, rate),
    };
  }

  private async findRow(id: string): Promise<BillingItemRow> {
    const [row] = await this.db.select().from(billingItems).where(eq(billingItems.id, id)).limit(1);
    if (!row)
      throw problem(HttpStatus.NOT_FOUND, { type: BILLING_PROBLEM.notFound, detail: 'Оплата не найдена.' });
    return row;
  }

  async list(archived: boolean): Promise<{ items: BillingItem[] }> {
    const rows = await this.db
      .select()
      .from(billingItems)
      .where(archived ? isNotNull(billingItems.archivedAt) : isNull(billingItems.archivedAt))
      .orderBy(archived ? desc(billingItems.archivedAt) : asc(billingItems.paidUntil));
    const now = new Date();
    const known = await this.knownServerIds();
    // Курс берём один раз на весь список: он в кэше, но так список не ждёт ЦБ даже при пустом кэше.
    await this.rates.ratesOn(now).catch(() => null);
    return { items: await Promise.all(rows.map((r) => this.toDto(r, now, known))) };
  }

  private async validate(body: BillingItemUpsert): Promise<void> {
    const known = await this.knownServerIds();
    const unknown = body.serverIds.filter((id) => !known.has(id));
    if (unknown.length > 0)
      throw problem(HttpStatus.BAD_REQUEST, {
        detail: 'Один из выбранных серверов не найден — обновите страницу.',
      });
    if (body.providerId) {
      const [p] = await this.db
        .select({ id: providers.id })
        .from(providers)
        .where(eq(providers.id, body.providerId));
      if (!p) throw problem(HttpStatus.BAD_REQUEST, { detail: 'Провайдер не найден — обновите страницу.' });
    }
  }

  private values(body: BillingItemUpsert) {
    return {
      kind: body.kind,
      title: body.title,
      providerId: body.providerId,
      serverIds: [...new Set(body.serverIds)],
      domain: body.domain || null,
      amountMinor: minor(body.amount),
      currency: body.currency,
      periodUnit: body.periodUnit,
      periodCount: body.periodUnit === 'once' ? 1 : body.periodCount,
      paidUntil: new Date(body.paidUntil),
      autoCharge: body.periodUnit === 'once' ? false : body.autoCharge,
      remindDays: body.remindDays,
      note: body.note || null,
    };
  }

  async create(body: BillingItemUpsert): Promise<BillingItem> {
    await this.validate(body);
    const [row] = await this.db.insert(billingItems).values(this.values(body)).returning();
    if (!row) throw new Error('Оплата не записалась');
    this.audit.extend({
      target: { type: 'billing', id: row.id, display: row.title },
      metadata: { kind: BILLING_KIND_LABELS[row.kind], amount: formatMoney(row.amountMinor, row.currency) },
    });
    this.kickReminders();
    return this.toDto(row);
  }

  async update(id: string, body: BillingItemUpsert): Promise<BillingItem> {
    const before = await this.findRow(id);
    await this.validate(body);
    const v = this.values(body);
    const [row] = await this.db
      .update(billingItems)
      .set({
        ...v,
        updatedAt: new Date(),
        // Срок сдвинули вручную — напоминания для нового срока пойдут заново.
        ...(v.paidUntil.getTime() !== before.paidUntil.getTime()
          ? { notifiedState: null, notifiedAt: null }
          : {}),
      })
      .where(eq(billingItems.id, id))
      .returning();
    if (!row)
      throw problem(HttpStatus.NOT_FOUND, { type: BILLING_PROBLEM.notFound, detail: 'Оплата не найдена.' });
    const changes: Record<string, { before: unknown; after: unknown }> = {};
    if (before.title !== row.title) changes.title = { before: before.title, after: row.title };
    if (before.amountMinor !== row.amountMinor || before.currency !== row.currency)
      changes.amount = {
        before: formatMoney(before.amountMinor, before.currency),
        after: formatMoney(row.amountMinor, row.currency),
      };
    if (before.paidUntil.getTime() !== row.paidUntil.getTime())
      changes.paidUntil = { before: before.paidUntil.toISOString(), after: row.paidUntil.toISOString() };
    if (before.periodUnit !== row.periodUnit || before.periodCount !== row.periodCount)
      changes.period = {
        before: billingPeriodLabel(before.periodUnit, before.periodCount),
        after: billingPeriodLabel(row.periodUnit, row.periodCount),
      };
    this.audit.extend({
      target: { type: 'billing', id: row.id, display: row.title },
      ...(Object.keys(changes).length > 0 ? { changes } : {}),
    });
    this.kickReminders();
    return this.toDto(row);
  }

  async remove(id: string): Promise<void> {
    const row = await this.findRow(id);
    await this.db.delete(billingItems).where(eq(billingItems.id, id));
    this.audit.extend({ target: { type: 'billing', id: row.id, display: row.title } });
  }

  async setArchived(id: string, archived: boolean): Promise<BillingItem> {
    const before = await this.findRow(id);
    const [row] = await this.db
      .update(billingItems)
      .set({ archivedAt: archived ? new Date() : null, updatedAt: new Date() })
      .where(eq(billingItems.id, id))
      .returning();
    if (!row)
      throw problem(HttpStatus.NOT_FOUND, { type: BILLING_PROBLEM.notFound, detail: 'Оплата не найдена.' });
    this.audit.extend({
      target: { type: 'billing', id: row.id, display: before.title },
      metadata: { archived },
    });
    return this.toDto(row);
  }

  /** Записать продление. Сумма в рублях — по курсу ЦБ на день оплаты; нет курса — досчитает фоновая задача. */
  private async recordExtend(
    row: BillingItemRow,
    to: Date,
    counted: boolean,
    amountMinor: number,
    actorDisplay: string | null,
    paidAt = new Date(),
  ): Promise<{ item: BillingItemRow; payment: BillingPaymentRow }> {
    const rate = await this.rates.rate(row.currency, paidAt);
    return this.db.transaction(async (tx) => {
      const [payment] = await tx
        .insert(billingPayments)
        .values({
          itemId: row.id,
          paidAt,
          counted,
          amountMinor: counted ? amountMinor : 0,
          currency: row.currency,
          rate: rate ?? 0,
          amountRubMinor: counted && rate !== null ? toRubMinor(amountMinor, rate) : 0,
          extendedFrom: row.paidUntil,
          extendedTo: to,
          actorDisplay,
        })
        .returning();
      const [item] = await tx
        .update(billingItems)
        .set({ paidUntil: to, notifiedState: null, notifiedAt: null, updatedAt: new Date() })
        .where(eq(billingItems.id, row.id))
        .returning();
      if (!payment || !item) throw new Error('Продление не записалось');
      return { item, payment };
    });
  }

  private paymentDto(p: BillingPaymentRow, undoable: boolean): BillingPayment {
    return {
      id: p.id,
      itemId: p.itemId,
      paidAt: p.paidAt.toISOString(),
      counted: p.counted,
      amountMinor: p.amountMinor,
      currency: p.currency,
      rate: p.rate,
      amountRubMinor: p.amountRubMinor,
      extendedFrom: p.extendedFrom.toISOString(),
      extendedTo: p.extendedTo.toISOString(),
      actor: p.actorDisplay,
      undoable,
    };
  }

  async extend(id: string, req: BillingExtend): Promise<{ item: BillingItem; payment: BillingPayment }> {
    const row = await this.findRow(id);
    const to = extendTarget(row.paidUntil, req, row.periodUnit, row.periodCount);
    if (!to)
      throw problem(HttpStatus.BAD_REQUEST, {
        detail: 'Разовую оплату продлевают на число дней или до точной даты.',
      });
    if (to.getTime() === row.paidUntil.getTime())
      throw problem(HttpStatus.BAD_REQUEST, { detail: 'Новая дата совпадает с текущей.' });
    const amountMinor = req.amount !== undefined ? minor(req.amount) : row.amountMinor;
    const { item, payment } = await this.recordExtend(row, to, req.count, amountMinor, this.actorDisplay());
    this.audit.extend({
      target: { type: 'billing', id: row.id, display: row.title },
      changes: { paidUntil: { before: row.paidUntil.toISOString(), after: to.toISOString() } },
      metadata: {
        amount: req.count ? formatMoney(amountMinor, row.currency) : 'без учёта суммы',
        ...(payment.rate && row.currency !== 'RUB' ? { rate: payment.rate } : {}),
      },
    });
    this.kickReminders();
    return { item: await this.toDto(item), payment: this.paymentDto(payment, true) };
  }

  async payments(id: string): Promise<{ items: BillingPayment[] }> {
    const row = await this.findRow(id);
    const rows = await this.db
      .select()
      .from(billingPayments)
      .where(eq(billingPayments.itemId, id))
      .orderBy(desc(billingPayments.paidAt), desc(billingPayments.id))
      .limit(100);
    return {
      items: rows.map((p, i) =>
        this.paymentDto(p, i === 0 && p.extendedTo.getTime() === row.paidUntil.getTime()),
      ),
    };
  }

  private async findPayment(id: string): Promise<BillingPaymentRow> {
    const [p] = await this.db.select().from(billingPayments).where(eq(billingPayments.id, id)).limit(1);
    if (!p)
      throw problem(HttpStatus.NOT_FOUND, {
        type: BILLING_PROBLEM.notFound,
        detail: 'Запись оплаты не найдена.',
      });
    return p;
  }

  /** Поправить дату или сумму оплаты: курс берётся на новую дату. */
  async updatePayment(
    id: string,
    req: { paidAt?: string | undefined; amount?: number | undefined },
  ): Promise<BillingPayment> {
    const p = await this.findPayment(id);
    const item = await this.findRow(p.itemId);
    const paidAt = req.paidAt ? new Date(req.paidAt) : p.paidAt;
    const amountMinor = req.amount !== undefined ? minor(req.amount) : p.amountMinor;
    const counted = req.amount !== undefined ? true : p.counted;
    const rate = await this.rates.rate(p.currency, paidAt);
    const [row] = await this.db
      .update(billingPayments)
      .set({
        paidAt,
        amountMinor,
        counted,
        rate: rate ?? 0,
        amountRubMinor: counted && rate !== null ? toRubMinor(amountMinor, rate) : 0,
      })
      .where(eq(billingPayments.id, id))
      .returning();
    if (!row) throw problem(HttpStatus.NOT_FOUND, { detail: 'Запись оплаты не найдена.' });
    this.audit.extend({
      target: { type: 'billing', id: item.id, display: item.title },
      changes: {
        ...(req.paidAt ? { paidAt: { before: p.paidAt.toISOString(), after: paidAt.toISOString() } } : {}),
        ...(req.amount !== undefined
          ? {
              amount: {
                before: formatMoney(p.amountMinor, p.currency),
                after: formatMoney(amountMinor, p.currency),
              },
            }
          : {}),
      },
    });
    return this.paymentDto(row, false);
  }

  /** Отменить последнее продление: дата возвращается, запись оплаты удаляется. */
  async undo(paymentId: string): Promise<BillingItem> {
    const p = await this.findPayment(paymentId);
    const item = await this.findRow(p.itemId);
    const [latest] = await this.db
      .select({ id: billingPayments.id })
      .from(billingPayments)
      .where(eq(billingPayments.itemId, item.id))
      .orderBy(desc(billingPayments.paidAt), desc(billingPayments.id))
      .limit(1);
    if (latest?.id !== p.id || p.extendedTo.getTime() !== item.paidUntil.getTime())
      throw problem(HttpStatus.CONFLICT, {
        type: BILLING_PROBLEM.undo,
        detail: 'Отменить можно только последнее продление, пока дату не меняли.',
      });
    const [row] = await this.db.transaction(async (tx) => {
      await tx.delete(billingPayments).where(eq(billingPayments.id, p.id));
      return tx
        .update(billingItems)
        .set({ paidUntil: p.extendedFrom, notifiedState: null, notifiedAt: null, updatedAt: new Date() })
        .where(eq(billingItems.id, item.id))
        .returning();
    });
    if (!row) throw problem(HttpStatus.NOT_FOUND, { detail: 'Оплата не найдена.' });
    this.audit.extend({
      target: { type: 'billing', id: item.id, display: item.title },
      changes: { paidUntil: { before: item.paidUntil.toISOString(), after: p.extendedFrom.toISOString() } },
    });
    return this.toDto(row);
  }

  /* ─────────── Итоги и статистика ─────────── */

  private async total(
    from: Date,
    to: Date,
    active: BillingItemRow[],
    now: Date,
    rates: { usd: number; eur: number } | null,
  ): Promise<BillingTotal> {
    const rows = await this.db
      .select()
      .from(billingPayments)
      .where(
        and(
          eq(billingPayments.counted, true),
          gte(billingPayments.paidAt, from),
          lt(billingPayments.paidAt, to),
        ),
      );
    const byCurrency = new Map<BillingCurrency, number>();
    let spent = 0;
    for (const p of rows) {
      spent += p.amountRubMinor;
      byCurrency.set(p.currency, (byCurrency.get(p.currency) ?? 0) + p.amountMinor);
    }
    // Ожидается: оставшиеся сроки до конца периода по сегодняшнему курсу.
    let expected = 0;
    const start = now > from ? now : from;
    if (start < to)
      for (const it of active) {
        const n = occurrencesUntil(it, start, to);
        if (n === 0) continue;
        const rate = it.currency === 'RUB' ? 1 : it.currency === 'USD' ? rates?.usd : rates?.eur;
        if (rate) expected += n * toRubMinor(it.amountMinor, rate);
      }
    return {
      spentRubMinor: spent,
      payments: rows.length,
      byCurrency: [...byCurrency].map(([currency, amountMinor]) => ({ currency, amountMinor })),
      expectedRubMinor: expected,
      from: from.toISOString(),
      to: to.toISOString(),
    };
  }

  private async activeRows(): Promise<BillingItemRow[]> {
    return this.db
      .select()
      .from(billingItems)
      .where(isNull(billingItems.archivedAt))
      .orderBy(asc(billingItems.paidUntil));
  }

  async summary(tzRaw?: string): Promise<BillingSummary> {
    const tz = validTz(tzRaw);
    const now = new Date();
    const active = await this.activeRows();
    const r = await this.rates.ratesOn(now).catch(() => null);
    const totals = await Promise.all(
      (['day', 'week', 'month', 'year'] as const).map((p) => {
        const b = periodBounds(p, now, tz);
        return this.total(b.from, b.to, active, now, r);
      }),
    );
    const known = await this.knownServerIds();
    const byServer = new Map<string, BillingSummary['byServer'][number]>();
    for (const it of active) {
      if (it.kind !== 'server' && it.kind !== 'rent') continue;
      for (const sid of it.serverIds) {
        if (!known.has(sid) || byServer.has(sid)) continue;
        byServer.set(sid, {
          serverId: sid,
          itemId: it.id,
          title: it.title,
          paidUntil: it.paidUntil.toISOString(),
          dueState: dueStateOf(it, now),
          amountMinor: it.amountMinor,
          currency: it.currency,
        });
      }
    }
    const first = active[0];
    const [day, week, month, year] = totals as [BillingTotal, BillingTotal, BillingTotal, BillingTotal];
    return {
      day,
      week,
      month,
      year,
      overdue: active.filter((i) => dueStateOf(i, now) === 'overdue').length,
      dueToday: active.filter((i) => dueStateOf(i, now) === 'today').length,
      next: first
        ? {
            itemId: first.id,
            title: first.title,
            paidUntil: first.paidUntil.toISOString(),
            amountMinor: first.amountMinor,
            currency: first.currency,
          }
        : null,
      byServer: [...byServer.values()],
      rates: {
        USD: r?.usd ?? null,
        EUR: r?.eur ?? null,
        date: r?.date ?? null,
        fetchedAt: r?.fetchedAt.toISOString() ?? null,
      },
    };
  }

  async stats(period: BillingStatPeriod, tzRaw?: string): Promise<BillingStats> {
    const tz = validTz(tzRaw);
    const now = new Date();
    const active = await this.activeRows();
    const r = await this.rates.ratesOn(now).catch(() => null);
    const b = periodBounds(period, now, tz);
    const total = await this.total(b.from, b.to, active, now, r);
    const rows = await this.db
      .select({
        rub: billingPayments.amountRubMinor,
        paidAt: billingPayments.paidAt,
        kind: billingItems.kind,
        providerId: billingItems.providerId,
        providerName: providers.name,
      })
      .from(billingPayments)
      .innerJoin(billingItems, eq(billingItems.id, billingPayments.itemId))
      .leftJoin(providers, eq(providers.id, billingItems.providerId))
      .where(
        and(
          eq(billingPayments.counted, true),
          gte(billingPayments.paidAt, periodBounds('year', now, tz).from),
          lt(billingPayments.paidAt, periodBounds('year', now, tz).to),
        ),
      );
    const inPeriod = rows.filter((x) => x.paidAt >= b.from && x.paidAt < b.to);
    const prov = new Map<string, { providerId: string | null; name: string; rubMinor: number }>();
    const kinds = new Map<string, number>();
    for (const x of inPeriod) {
      const key = x.providerId ?? '—';
      const cur = prov.get(key) ?? {
        providerId: x.providerId,
        name: x.providerName ?? 'Без провайдера',
        rubMinor: 0,
      };
      cur.rubMinor += x.rub;
      prov.set(key, cur);
      kinds.set(x.kind, (kinds.get(x.kind) ?? 0) + x.rub);
    }
    const months = Array.from({ length: 12 }, (_, i) => ({
      month: i + 1,
      byKind: {} as Record<string, number>,
    }));
    for (const x of rows) {
      const m = localDate(x.paidAt, tz).m;
      const bucket = months[m - 1];
      if (bucket) bucket.byKind[x.kind] = (bucket.byKind[x.kind] ?? 0) + x.rub;
    }
    return {
      period,
      total,
      byProvider: [...prov.values()].sort((a, c) => c.rubMinor - a.rubMinor),
      byKind: BILLING_KINDS.filter((k) => kinds.has(k)).map((k) => ({
        kind: k,
        rubMinor: kinds.get(k) ?? 0,
      })),
      months,
    };
  }

  /** Прогноз: сколько предстоит заплатить — по неделям, по месяцам, до конца года и в год. */
  async forecast(tzRaw?: string): Promise<BillingForecast> {
    const tz = validTz(tzRaw);
    const now = new Date();
    const active = await this.activeRows();
    const r = await this.rates.ratesOn(now).catch(() => null);
    const prov = await this.db.select({ id: providers.id, name: providers.name }).from(providers);
    const pName = new Map(prov.map((p) => [p.id, p.name]));
    const rateOf = (c: BillingCurrency) =>
      c === 'RUB' ? 1 : c === 'USD' ? (r?.usd ?? null) : (r?.eur ?? null);
    const { y, m } = localDate(now, tz);
    const yearEnd = periodBounds('year', now, tz).to;
    const horizon = new Date(
      Math.max(yearEnd.getTime(), localMidnight(y, m + 4, 1, tz).getTime(), now.getTime() + 366 * DAY_MS),
    );
    let rateMissing = false;
    const all: BillingForecastItem[] = [];
    for (const it of active) {
      const rate = rateOf(it.currency);
      if (rate === null) rateMissing = true;
      for (const o of occurrenceDates(it, now, horizon))
        all.push({
          itemId: it.id,
          title: it.title,
          provider: it.providerId ? (pName.get(it.providerId) ?? null) : null,
          date: o.at.toISOString(),
          overdue: o.overdue,
          amountMinor: it.amountMinor,
          currency: it.currency,
          rubMinor: rate === null ? null : toRubMinor(it.amountMinor, rate),
          auto: it.autoCharge,
        });
    }
    all.sort((a, b) => Date.parse(a.date) - Date.parse(b.date));
    const within = (from: Date, to: Date) =>
      all.filter((i) => Date.parse(i.date) >= from.getTime() && Date.parse(i.date) < to.getTime());
    const sum = (list: BillingForecastItem[]) => list.reduce((a, i) => a + (i.rubMinor ?? 0), 0);
    const in7 = within(now, new Date(now.getTime() + 7 * DAY_MS));
    const in30 = within(now, new Date(now.getTime() + 30 * DAY_MS));
    const inYear = within(now, yearEnd);
    // В год — нынешний набор оплат, приведённый к году: месяц — 12 раз, неделя — 52, день — 365; разовые не входят.
    const perYear = active.reduce((acc, it) => {
      const rate = rateOf(it.currency);
      const times = timesPerYear(it.periodUnit, it.periodCount);
      return rate === null || times === 0 ? acc : acc + Math.round(times * toRubMinor(it.amountMinor, rate));
    }, 0);

    const week = periodBounds('week', now, tz);
    const weeks: BillingForecast['weeks'] = [];
    for (let i = 0; i < 3; i += 1) {
      const from = new Date(week.from.getTime() + i * 7 * DAY_MS);
      const to = new Date(week.to.getTime() + i * 7 * DAY_MS);
      const items = within(i === 0 ? now : from, to);
      weeks.push({ from: from.toISOString(), to: to.toISOString(), rubMinor: sum(items), items });
    }

    const monthFrom = localMidnight(y, m - 3, 1, tz);
    const paidRows = await this.db
      .select({ rub: billingPayments.amountRubMinor, paidAt: billingPayments.paidAt })
      .from(billingPayments)
      .where(and(eq(billingPayments.counted, true), gte(billingPayments.paidAt, monthFrom)));
    const months: BillingForecast['months'] = [];
    for (let off = -3; off <= 3; off += 1) {
      const from = localMidnight(y, m + off, 1, tz);
      const to = localMidnight(y, m + off + 1, 1, tz);
      const ld = localDate(from, tz);
      months.push({
        year: ld.y,
        month: ld.m,
        paidRubMinor: paidRows
          .filter((p) => p.paidAt >= from && p.paidAt < to)
          .reduce((a, p) => a + p.rub, 0),
        forecastRubMinor: to <= now ? 0 : sum(within(from > now ? from : now, to)),
      });
    }
    return {
      next7: { rubMinor: sum(in7), count: in7.length },
      next30: { rubMinor: sum(in30), count: in30.length, auto: in30.filter((i) => i.auto).length },
      restOfYear: { rubMinor: sum(inYear), months: 12 - m + 1 },
      perYearRubMinor: perYear,
      first: all[0] ?? null,
      weeks,
      months,
      rateMissing,
    };
  }

  /* ─────────── Для Джарвиса и разбора инцидентов ─────────── */

  private async briefs(rows: BillingItemRow[], now: Date): Promise<BillingBrief[]> {
    const [srv, prov] = await Promise.all([
      this.db.select({ id: servers.id, name: servers.name }).from(servers),
      this.db.select({ id: providers.id, name: providers.name }).from(providers),
    ]);
    const sName = new Map(srv.map((s) => [s.id, s.name]));
    const pName = new Map(prov.map((p) => [p.id, p.name]));
    const out: BillingBrief[] = [];
    for (const it of rows) {
      const rate = await this.rates.rate(it.currency, now, { fetch: false });
      out.push({
        id: it.id,
        kind: BILLING_KIND_LABELS[it.kind],
        title: it.title,
        provider: it.providerId ? (pName.get(it.providerId) ?? null) : null,
        servers: it.serverIds.map((id) => sName.get(id)).filter((x): x is string => Boolean(x)),
        domain: it.domain,
        amount: formatMoney(it.amountMinor, it.currency),
        amountRub:
          it.currency !== 'RUB' && rate !== null ? `≈ ${formatRub(toRubMinor(it.amountMinor, rate))}` : null,
        period: billingPeriodLabel(it.periodUnit, it.periodCount),
        paidUntil: it.paidUntil.toISOString(),
        due: it.archivedAt ? 'в архиве' : dueInWords(it.paidUntil, now),
        state: dueStateOf(it, now),
        autoCharge: it.autoCharge,
        note: it.note,
      });
    }
    return out;
  }

  /** Всё про биллинг для Джарвиса: активные оплаты по сроку, итоги месяца, при желании — архив. */
  async forAssistant(opts: { archived?: boolean; serverId?: string | null } = {}): Promise<{
    items: BillingBrief[];
    archived?: BillingBrief[];
    month: { spent: string; expected: string; payments: number };
    year: { spent: string };
    rates: string | null;
    forecast: {
      next7: string;
      next30: string;
      restOfYear: string;
      perYear: string;
      byMonth: Array<{ month: string; paid: string; forecast: string }>;
      upcoming: Array<{ title: string; date: string; amount: string; rub: string | null; auto: boolean }>;
      note: string;
    };
  }> {
    const now = new Date();
    let active = await this.activeRows();
    if (opts.serverId) active = active.filter((i) => i.serverIds.includes(opts.serverId as string));
    // Границы «месяца» и «года» — по поясу панели, как и остальное время у Джарвиса.
    const tz = await this.notifications.timeZone().catch(() => DEFAULT_TZ);
    const s = await this.summary(tz);
    const f = await this.forecast(tz);
    const MONTHS = [
      'январь',
      'февраль',
      'март',
      'апрель',
      'май',
      'июнь',
      'июль',
      'август',
      'сентябрь',
      'октябрь',
      'ноябрь',
      'декабрь',
    ];
    const out: Awaited<ReturnType<BillingService['forAssistant']>> = {
      forecast: {
        next7: `≈ ${formatRub(f.next7.rubMinor)} (${f.next7.count})`,
        next30: `≈ ${formatRub(f.next30.rubMinor)} (${f.next30.count}, из них автоплатежом ${f.next30.auto})`,
        restOfYear: `≈ ${formatRub(f.restOfYear.rubMinor)}`,
        perYear: `≈ ${formatRub(f.perYearRubMinor)}`,
        byMonth: f.months.map((mm) => ({
          month: `${MONTHS[mm.month - 1]} ${mm.year}`,
          paid: formatRub(mm.paidRubMinor),
          forecast: `≈ ${formatRub(mm.forecastRubMinor)}`,
        })),
        upcoming: f.weeks
          .flatMap((w) => w.items)
          .slice(0, 15)
          .map((i) => ({
            title: i.title,
            date: i.overdue ? 'просрочено — платить сейчас' : i.date,
            amount: formatMoney(i.amountMinor, i.currency),
            rub: i.currency === 'RUB' || i.rubMinor === null ? null : `≈ ${formatRub(i.rubMinor)}`,
            auto: i.auto,
          })),
        note: 'Прогноз по активным оплатам, $ и € — по сегодняшнему курсу ЦБ (приблизительно). «perYear» — нынешний набор оплат в пересчёте на год.',
      },
      items: await this.briefs(active, now),
      month: {
        spent: formatRub(s.month.spentRubMinor),
        expected: formatRub(s.month.expectedRubMinor),
        payments: s.month.payments,
      },
      year: { spent: formatRub(s.year.spentRubMinor) },
      rates: s.rates.USD
        ? `ЦБ на ${s.rates.date}: $ ${s.rates.USD.toFixed(2)} ₽, € ${s.rates.EUR?.toFixed(2)} ₽`
        : null,
    };
    if (opts.archived) {
      const arch = await this.db
        .select()
        .from(billingItems)
        .where(isNotNull(billingItems.archivedAt))
        .orderBy(desc(billingItems.archivedAt))
        .limit(30);
      out.archived = await this.briefs(arch, now);
    }
    return out;
  }

  /**
   * Окно оплаты сервера (см. payment-window.ts): что просрочено, что истекает в ближайшие сутки, где
   * автоплатёж только что продлил срок, и ближайший срок остальных оплат. Факты идут в текст инцидента и
   * в разбор Джарвиса; сроки — в поясе панели. total = 0 — оплат этого сервера в «Биллинге» нет.
   * Берутся оплаты всех видов: какой вид что объясняет, решает тот, кто пишет вывод (payment-hint.ts).
   */
  async paymentWindowForServer(serverId: string, now = new Date()): Promise<PaymentWindow> {
    const rows = await this.db
      .select()
      .from(billingItems)
      .where(
        and(
          isNull(billingItems.archivedAt),
          sql`${billingItems.serverIds} @> ${JSON.stringify([serverId])}::jsonb`,
        ),
      );
    const timeZone = validTz(await this.notifications.timeZone().catch(() => DEFAULT_TZ));
    if (rows.length === 0) return buildPaymentWindow([], [], now, timeZone);
    const prov = await this.db.select({ id: providers.id, name: providers.name }).from(providers);
    const pName = new Map(prov.map((p) => [p.id, p.name]));
    const entries = new Map<string, PaymentEntry>(
      rows.map((it) => [
        it.id,
        {
          kind: it.kind,
          kindLabel: BILLING_KIND_LABELS[it.kind],
          title: it.title,
          provider: it.providerId ? (pName.get(it.providerId) ?? null) : null,
          amount: formatMoney(it.amountMinor, it.currency),
          paidUntil: it.paidUntil,
          autoCharge: it.autoCharge,
          periodMs: periodMs(it.periodUnit, it.periodCount),
        },
      ]),
    );
    // Автоплатёж панель продлевает сама, не зная, прошло ли списание: недавнее продление — тоже «окно».
    const renewed = await this.db
      .select({ itemId: billingPayments.itemId, at: billingPayments.extendedFrom })
      .from(billingPayments)
      .where(
        and(
          inArray(billingPayments.itemId, [...entries.keys()]),
          eq(billingPayments.actorDisplay, AUTO_CHARGE_ACTOR),
          gte(billingPayments.extendedFrom, new Date(now.getTime() - PAYMENT_WINDOW_MS)),
        ),
      )
      .orderBy(desc(billingPayments.extendedFrom));
    const seen = new Set<string>();
    const renewals: Array<{ entry: PaymentEntry; at: Date }> = [];
    for (const r of renewed) {
      const entry = entries.get(r.itemId);
      if (!entry || seen.has(r.itemId)) continue;
      seen.add(r.itemId);
      renewals.push({ entry, at: r.at });
    }
    return buildPaymentWindow([...entries.values()], renewals, now, timeZone);
  }

  /* ─────────── Фоновая задача: автоплатёж, напоминания, досчёт рублей ─────────── */

  /** Автоплатёж: в срок продлеваем на период и учитываем сумму карточки. */
  async runAutoCharge(now = new Date()): Promise<number> {
    const due = await this.db
      .select()
      .from(billingItems)
      .where(
        and(
          isNull(billingItems.archivedAt),
          eq(billingItems.autoCharge, true),
          ne(billingItems.periodUnit, 'once'),
          lte(billingItems.paidUntil, now),
        ),
      );
    let n = 0;
    for (let row of due) {
      for (let i = 0; i < 60 && row.paidUntil <= now; i += 1) {
        const to = extendTarget(row.paidUntil, { period: true }, row.periodUnit, row.periodCount);
        if (!to) break;
        const res = await this.recordExtend(row, to, true, row.amountMinor, AUTO_CHARGE_ACTOR, row.paidUntil);
        row = res.item;
        n += 1;
      }
      await this.audit.record({
        action: 'billing.autocharge',
        actor: SYSTEM_ACTOR,
        target: { type: 'billing', id: row.id, display: row.title },
        metadata: {
          paidUntil: row.paidUntil.toISOString(),
          amount: formatMoney(row.amountMinor, row.currency),
        },
      });
    }
    return n;
  }

  /** Досчитать рубли у оплат, записанных без курса (ЦБ был недоступен). */
  async fillMissingRates(): Promise<number> {
    const rows = await this.db
      .select()
      .from(billingPayments)
      .where(and(eq(billingPayments.rate, 0), ne(billingPayments.currency, 'RUB')))
      .limit(50);
    let n = 0;
    for (const p of rows) {
      const rate = await this.rates.rate(p.currency, p.paidAt);
      if (rate === null) continue;
      await this.db
        .update(billingPayments)
        .set({ rate, amountRubMinor: p.counted ? toRubMinor(p.amountMinor, rate) : 0 })
        .where(eq(billingPayments.id, p.id));
      n += 1;
    }
    return n;
  }

  /**
   * Серверы оплаты, по которым сейчас открыто дело «Сервер недоступен», само называющее оплату (в заголовке
   * «проверьте оплату» или «просрочена оплата»): там неоплата — вероятная причина. Где дело об оплате молчит
   * (порт с панели открыт) или называет общую причину, напоминание не должно быть увереннее самого дела.
   * Только для оплат самого сервера (хостинг и аренда): сертификат, домен и «Другое» сервер не выключают.
   * «Агент не в сети», «SSH недоступен», остановленная нода и блокировка — сервер работает, оплата ни при чём.
   */
  private async downServers(ids: string[], kind: BillingKind): Promise<Set<string>> {
    if (ids.length === 0 || !SERVER_PAYMENT_KINDS.includes(kind)) return new Set();
    const rows = await this.db
      .select({ serverId: incidents.serverId })
      .from(incidents)
      .where(
        and(
          inArray(incidents.serverId, ids),
          ne(incidents.status, 'resolved'),
          eq(incidents.kind, 'server_down'),
          sql`${incidents.title} like ${'%оплат%'}`,
          // Оплата в заголовке — ещё не уверенность: при неполной проверке дело пишет «Проверьте оплату: …
          // возможно…». «Вероятно, из-за неоплаты» напоминание говорит, только когда так говорит само дело.
          sql`${incidents.detail} like ${'%Вероятнее всего%'}`,
        ),
      );
    return new Set(rows.map((r) => r.serverId).filter((x): x is string => Boolean(x)));
  }

  /**
   * Напоминания: «скоро» — один раз на срок, без звука; «просрочено» — в день срока и раз в сутки, пока не
   * продлят. Карточки с автоплатежом не напоминаем — их продлевает runAutoCharge.
   */
  async runReminders(now = new Date()): Promise<number> {
    const rows = await this.db
      .select()
      .from(billingItems)
      .where(
        and(
          isNull(billingItems.archivedAt),
          eq(billingItems.autoCharge, false),
          lte(billingItems.paidUntil, new Date(now.getTime() + 60 * DAY_MS)),
        ),
      );
    let sent = 0;
    const timeZone = await this.notifications.timeZone().catch(() => DEFAULT_TZ);
    const [srv, prov] = await Promise.all([
      this.db.select({ id: servers.id, name: servers.name }).from(servers),
      this.db.select({ id: providers.id, name: providers.name }).from(providers),
    ]);
    const sName = new Map(srv.map((s) => [s.id, s.name]));
    const pName = new Map(prov.map((p) => [p.id, p.name]));
    for (const it of rows) {
      const state = dueStateOf(it, now);
      let kind: 'soon' | 'overdue' | null = null;
      if (state === 'overdue') {
        const last = it.notifiedState === 'overdue' ? it.notifiedAt : null;
        if (!last || now.getTime() - last.getTime() >= DAY_MS) kind = 'overdue';
      } else if ((state === 'soon' || state === 'today') && it.notifiedState === null) kind = 'soon';
      if (!kind) continue;
      const ids = it.serverIds.filter((id) => sName.has(id));
      const down = await this.downServers(ids, it.kind as BillingKind);
      const rate = await this.rates.rate(it.currency, now);
      const message = {
        state: kind,
        kind: it.kind,
        title: it.title,
        provider: it.providerId ? (pName.get(it.providerId) ?? null) : null,
        domain: it.domain,
        amountMinor: it.amountMinor,
        currency: it.currency,
        amountRubMinor: rate === null ? null : toRubMinor(it.amountMinor, rate),
        periodUnit: it.periodUnit,
        periodCount: it.periodCount,
        paidUntil: it.paidUntil,
        servers: ids.map((id) => ({ name: sName.get(id) ?? 'сервер', down: down.has(id) })),
        note: it.note,
        now,
        timeZone,
      } as const;
      const html = formatBillingMessage(message);
      const rich = formatBillingRichMessage(message);
      const downNames = ids.filter((id) => down.has(id)).map((id) => sName.get(id));
      await this.notifications.push({
        severity: kind === 'overdue' ? 'crit' : 'warn',
        title:
          kind === 'overdue'
            ? `Оплата просрочена: ${it.title}`
            : `Скоро оплата: ${it.title} — ${dueInWords(it.paidUntil, now)}`,
        body: `${formatMoney(it.amountMinor, it.currency)} · ${billingPeriodLabel(it.periodUnit, it.periodCount)}${
          kind === 'overdue' && downNames.length > 0
            ? `. ${downNames.join(', ')} ${downNames.length > 1 ? 'недоступны' : 'недоступен'} — вероятно, из-за неоплаты.`
            : ''
        }`,
        // Страница биллинга — подпункт «Серверы»; ?item открывает окно «Продлить» у этой оплаты.
        link: { to: `/servers/billing?item=${it.id}`, label: 'Открыть биллинг' },
        telegram: {
          event: kind === 'overdue' ? 'billing_overdue' : 'billing_soon',
          html,
          rich,
          serverKey: null,
        },
      });
      await this.db
        .update(billingItems)
        .set({ notifiedState: kind, notifiedAt: now })
        .where(eq(billingItems.id, it.id));
      sent += 1;
      this.log.log(
        `Биллинг: ${kind === 'overdue' ? 'просрочено' : 'скоро оплата'} — «${it.title}», срок ${it.paidUntil.toISOString()}`,
      );
    }
    return sent;
  }

  /** Проверка сроков идёт одна за раз: и по минутной задаче, и сразу после правки карточки. */
  private remindersBusy = false;

  async tick(): Promise<void> {
    // Шаги независимы: сбой автоплатежа или досчёта курса не должен отменять напоминания.
    const step = async (name: string, fn: () => Promise<unknown>) => {
      try {
        await fn();
      } catch (err) {
        this.log.warn(`Биллинг (${name}): ${err instanceof Error ? err.message : err}`);
      }
    };
    await step('автоплатёж', () => this.runAutoCharge());
    await step('напоминания', () => this.checkReminders());
    await step('курс ЦБ', () => this.fillMissingRates());
    // Курс на сегодня панель получает сама, вскоре после полуночи по Москве, а не при первом открытии
    // «Биллинга»: страница не ждёт ЦБ, а «Обновлено …» рядом с курсом значит именно это. ЦБ не ответил —
    // следующая попытка не раньше чем через полчаса (см. BillingRatesService).
    await step('курс ЦБ на сегодня', () => this.rates.ratesOn(new Date()));
  }

  /** Напоминания без наложения запусков. */
  async checkReminders(): Promise<number> {
    if (this.remindersBusy) return 0;
    this.remindersBusy = true;
    try {
      return await this.runReminders();
    } finally {
      this.remindersBusy = false;
    }
  }

  /** После правки даты — проверить сразу, не дожидаясь минутной задачи. */
  private kickReminders(): void {
    if (process.env.NODE_ENV === 'test') return;
    setTimeout(() => {
      this.checkReminders().catch((err) =>
        this.log.warn(`Биллинг (напоминания): ${err instanceof Error ? err.message : err}`),
      );
    }, 500);
  }
}
