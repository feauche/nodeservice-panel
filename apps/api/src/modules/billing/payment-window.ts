import { type BillingKind, billingDueInWords } from '@nodeservice/shared';

import { localDateTime, zoneLabel } from '../../common/local-time.js';

/**
 * Окно оплаты (решение владельца 30.09.2026): срок оплаты уже прошёл или наступит в ближайшие сутки.
 * Срок в карточке «Биллинга» приблизительный — хостер или арендодатель отключает и раньше записанного
 * времени, когда на балансе кончились деньги. Поэтому при сбое связи близкий срок — такая же вероятная
 * причина, как просрочка: панель и Джарвис предлагают проверить оплату, если другой причины не нашли.
 */
export const PAYMENT_WINDOW_MS = 24 * 3_600_000;

/**
 * Окно для конкретной оплаты: сутки, но не больше четверти её периода. Иначе оплата «каждый день» была бы
 * в окне всегда, и подсказка «проверьте оплату» появлялась бы при любом сбое. Разовая оплата — сутки.
 */
export function paymentWindowFor(periodMs: number | null): number {
  return periodMs === null ? PAYMENT_WINDOW_MS : Math.min(PAYMENT_WINDOW_MS, periodMs / 4);
}

/** Оплата сервера в том виде, в каком она попадает в текст: вид и сумма уже словами. */
export interface PaymentEntry {
  /** Вид оплаты: от него зависит, может ли она объяснить сбой (сертификат сервер не выключает). */
  kind: BillingKind;
  /** «Аренда», «Сервер», «Домен»… */
  kindLabel: string;
  title: string;
  provider: string | null;
  /** «2 500 ₽», «€4.51». */
  amount: string;
  paidUntil: Date;
  autoCharge: boolean;
  /** Длина периода оплаты, мс; null — разовая. */
  periodMs: number | null;
}

/** Одна оплата в окне. */
export interface PaymentFact {
  kind: BillingKind;
  /**
   * «Аренда «Guardora»: 2 500 ₽, оплачено до 30 сентября, 16:00 (UTC+6)» — без точки и без «через час»:
   * эта строка попадает в текст инцидента, он хранится, и относительный срок в нём устаревал бы.
   */
  text: string;
  /** Срок словами на момент запроса: «меньше чем через час», «просрочено на 15 часов». */
  when: string;
  autoCharge: boolean;
}

/** Что «Биллинг» знает об оплатах одного сервера — для текста инцидента и для разбора Джарвиса. */
export interface PaymentWindow {
  /** Срок прошёл. */
  overdue: PaymentFact[];
  /** Срок наступит в пределах окна. */
  dueSoon: PaymentFact[];
  /** Автоплатёж продлил срок недавно: прошло ли списание у провайдера, панель не знает. */
  autoRenewed: string[];
  /** Ближайший срок остальных оплат сервера; null — других оплат нет. */
  next: string | null;
  /** Сколько активных оплат привязано к серверу — всех видов, включая домены и сертификаты. */
  total: number;
  /**
   * Сколько из них — оплата самого сервера: хостинг («Сервер») или аренда. 0 — срока оплаты сервера панель
   * не знает, даже если к нему привязан сертификат или домен: по ним «оплата в порядке» сказать нельзя.
   */
  paying: number;
}

/** Виды оплат, от которых зависит, работает ли сам сервер. */
export const SERVER_PAYMENT_KINDS: readonly BillingKind[] = ['server', 'rent'];

const dueAt = (at: Date, now: Date, timeZone: string): string =>
  `${localDateTime(at, timeZone, now)} (${zoneLabel(at, timeZone)})`;

const who = (e: PaymentEntry): string => `${e.kindLabel} «${e.title}»${e.provider ? ` у ${e.provider}` : ''}`;

/** Оплата как факт: текст со сроком в поясе панели и отдельно — сколько до срока сейчас. */
export function paymentFact(e: PaymentEntry, now: Date, timeZone: string): PaymentFact {
  return {
    kind: e.kind,
    text: `${who(e)}: ${e.amount}, оплачено до ${dueAt(e.paidUntil, now, timeZone)}`,
    when: billingDueInWords(e.paidUntil, now),
    autoCharge: e.autoCharge,
  };
}

/** Факт одной строкой для Джарвиса: со сроком словами, без точки на конце. */
export function paymentFactLine(f: PaymentFact): string {
  return `${f.text} — ${f.when}${f.autoCharge ? ' (включён автоплатёж)' : ''}`;
}

/** Автоплатёж сработал недавно: срок панель продлила сама, а прошло ли списание — не знает. */
export function autoRenewedFact(e: PaymentEntry, at: Date, now: Date, timeZone: string): string {
  return `${who(e)}: ${e.amount} — автоплатёж, срок продлён ${dueAt(at, now, timeZone)}; прошло ли списание у провайдера, панель не знает`;
}

/**
 * Оплаты сервера по окну: просроченные, со сроком в пределах окна и ближайшая из остальных.
 * `renewals` — автопродления (оплата и момент, когда истёк прежний срок); в окно идут только свежие.
 */
export function buildPaymentWindow(
  entries: readonly PaymentEntry[],
  renewals: ReadonlyArray<{ entry: PaymentEntry; at: Date }>,
  now: Date,
  timeZone: string,
): PaymentWindow {
  const sorted = [...entries].sort((a, b) => a.paidUntil.getTime() - b.paidUntil.getTime());
  const nowMs = now.getTime();
  const left = (e: PaymentEntry) => e.paidUntil.getTime() - nowMs;
  const fact = (e: PaymentEntry) => paymentFact(e, now, timeZone);
  const later = sorted.find((e) => left(e) > paymentWindowFor(e.periodMs));
  return {
    overdue: sorted.filter((e) => left(e) <= 0).map(fact),
    dueSoon: sorted.filter((e) => left(e) > 0 && left(e) <= paymentWindowFor(e.periodMs)).map(fact),
    autoRenewed: renewals
      .filter((r) => r.at.getTime() <= nowMs && nowMs - r.at.getTime() <= paymentWindowFor(r.entry.periodMs))
      .map((r) => autoRenewedFact(r.entry, r.at, now, timeZone)),
    next: later ? paymentFactLine(fact(later)) : null,
    total: entries.length,
    paying: entries.filter((e) => SERVER_PAYMENT_KINDS.includes(e.kind)).length,
  };
}
