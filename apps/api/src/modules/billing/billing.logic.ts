import {
  addBillingPeriod,
  type BillingDueState,
  type BillingPeriodUnit,
  type BillingStatPeriod,
} from '@nodeservice/shared';

const DAY_MS = 86_400_000;
/** «Скоро» — меньше трёх суток до срока (если в карточке не задано своё «напомнить за»). */
export const SOON_DAYS_DEFAULT = 3;

/** Состояние срока: просрочено / сегодня (меньше суток) / скоро / нормально / архив. */
export function dueStateOf(
  item: { paidUntil: Date; archivedAt: Date | null; remindDays?: number | null },
  now: Date,
): BillingDueState {
  if (item.archivedAt) return 'archived';
  const left = item.paidUntil.getTime() - now.getTime();
  if (left <= 0) return 'overdue';
  if (left < DAY_MS) return 'today';
  if (left < (item.remindDays ?? SOON_DAYS_DEFAULT) * DAY_MS) return 'soon';
  return 'ok';
}

/** Смещение часового пояса в момент `at`, мс (Москва → +3 ч). Неизвестный пояс — как UTC. */
function tzOffset(at: Date, timeZone: string): number {
  try {
    const p: Record<string, string> = Object.fromEntries(
      new Intl.DateTimeFormat('en-US', {
        timeZone,
        hourCycle: 'h23',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      })
        .formatToParts(at)
        .map((x) => [x.type, x.value]),
    );
    const n = (k: string) => Number(p[k] ?? 0);
    const local = Date.UTC(n('year'), n('month') - 1, n('day'), n('hour'), n('minute'), n('second'));
    return local - Math.floor(at.getTime() / 1000) * 1000;
  } catch {
    return 0;
  }
}

/** Местная дата момента: { y, m (1–12), d, wd (1 — понедельник … 7) }. */
export function localDate(at: Date, timeZone: string): { y: number; m: number; d: number; wd: number } {
  const l = new Date(at.getTime() + tzOffset(at, timeZone));
  return {
    y: l.getUTCFullYear(),
    m: l.getUTCMonth() + 1,
    d: l.getUTCDate(),
    wd: ((l.getUTCDay() + 6) % 7) + 1,
  };
}

/** Полночь местной даты как момент UTC (с поправкой на переход времени). */
export function localMidnight(y: number, m: number, d: number, timeZone: string): Date {
  const guess = Date.UTC(y, m - 1, d);
  const first = guess - tzOffset(new Date(guess), timeZone);
  return new Date(guess - tzOffset(new Date(first), timeZone));
}

/** Календарные границы [from, to): день; неделя с понедельника; месяц с 1-го; год с 1 января. */
export function periodBounds(
  period: BillingStatPeriod,
  now: Date,
  timeZone: string,
): { from: Date; to: Date } {
  const { y, m, d, wd } = localDate(now, timeZone);
  if (period === 'day')
    return { from: localMidnight(y, m, d, timeZone), to: localMidnight(y, m, d + 1, timeZone) };
  if (period === 'week')
    return {
      from: localMidnight(y, m, d - wd + 1, timeZone),
      to: localMidnight(y, m, d - wd + 8, timeZone),
    };
  if (period === 'month')
    return { from: localMidnight(y, m, 1, timeZone), to: localMidnight(y, m + 1, 1, timeZone) };
  return { from: localMidnight(y, 1, 1, timeZone), to: localMidnight(y + 1, 1, 1, timeZone) };
}

/**
 * Сколько раз оплата понадобится до `to`: просроченная — один раз (долг), дальше по периоду.
 * Разовая — не больше одного раза. Ограничение 400 — на случай «каждый день» на год.
 */
export function occurrencesUntil(
  item: { paidUntil: Date; periodUnit: BillingPeriodUnit; periodCount: number },
  from: Date,
  to: Date,
): number {
  let d = item.paidUntil;
  let n = 0;
  if (d < from) {
    // Просрочено до начала периода — долг считаем один раз, дальше идём от сегодняшнего дня.
    n = 1;
    if (item.periodUnit === 'once') return n;
    while (d < from && n < 400) d = addBillingPeriod(d, item.periodUnit, item.periodCount);
  }
  while (d < to && n < 400) {
    n += 1;
    if (item.periodUnit === 'once') break;
    d = addBillingPeriod(d, item.periodUnit, item.periodCount);
  }
  return n;
}

/** Новая дата «оплачено до» для продления. */
export function extendTarget(
  paidUntil: Date,
  req: { period?: boolean | undefined; days?: number | undefined; until?: string | undefined },
  unit: BillingPeriodUnit,
  count: number,
): Date | null {
  if (req.until) return new Date(req.until);
  if (req.days) return new Date(paidUntil.getTime() + req.days * DAY_MS);
  if (req.period && unit !== 'once') return addBillingPeriod(paidUntil, unit, count);
  return null;
}

/** Рубли по курсу в копейках: 4.51 € (451) × 103.7 = 46 769. */
export const toRubMinor = (amountMinor: number, rate: number): number => Math.round(amountMinor * rate);

/** Срок словами — общий с интерфейсом. */
export { billingDueInWords as dueInWords } from '@nodeservice/shared';
