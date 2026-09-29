import { describe, expect, it } from 'vitest';

import {
  dueInWords,
  dueStateOf,
  extendTarget,
  occurrenceDates,
  occurrencesUntil,
  periodBounds,
} from './billing.logic.js';

const now = new Date('2026-09-29T09:00:00Z'); // вторник, 12:00 по Москве

describe('billing.logic', () => {
  it('состояние срока', () => {
    const base = { archivedAt: null };
    expect(dueStateOf({ ...base, paidUntil: new Date('2026-09-29T08:00:00Z') }, now)).toBe('overdue');
    expect(dueStateOf({ ...base, paidUntil: new Date('2026-09-29T20:00:00Z') }, now)).toBe('today');
    expect(dueStateOf({ ...base, paidUntil: new Date('2026-10-01T09:00:00Z') }, now)).toBe('soon');
    expect(dueStateOf({ ...base, paidUntil: new Date('2026-10-10T09:00:00Z') }, now)).toBe('ok');
    expect(dueStateOf({ ...base, paidUntil: new Date('2026-10-10T09:00:00Z'), remindDays: 14 }, now)).toBe(
      'soon',
    );
    expect(dueStateOf({ archivedAt: now, paidUntil: now }, now)).toBe('archived');
  });

  it('календарные границы по Москве: неделя с понедельника, месяц с первого числа', () => {
    const tz = 'Europe/Moscow';
    expect(periodBounds('day', now, tz)).toEqual({
      from: new Date('2026-09-28T21:00:00Z'),
      to: new Date('2026-09-29T21:00:00Z'),
    });
    expect(periodBounds('week', now, tz).from).toEqual(new Date('2026-09-27T21:00:00Z'));
    expect(periodBounds('week', now, tz).to).toEqual(new Date('2026-10-04T21:00:00Z'));
    expect(periodBounds('month', now, tz)).toEqual({
      from: new Date('2026-08-31T21:00:00Z'),
      to: new Date('2026-09-30T21:00:00Z'),
    });
    expect(periodBounds('year', now, tz).from).toEqual(new Date('2025-12-31T21:00:00Z'));
    // Поздний вечер 30-го по UTC — уже 1 октября в Москве.
    expect(periodBounds('month', new Date('2026-09-30T22:00:00Z'), tz).from).toEqual(
      new Date('2026-09-30T21:00:00Z'),
    );
  });

  it('сколько оплат до конца периода', () => {
    const from = now;
    const to = new Date('2026-10-01T00:00:00Z');
    expect(
      occurrencesUntil(
        { paidUntil: new Date('2026-09-30T00:00:00Z'), periodUnit: 'day', periodCount: 1 },
        from,
        to,
      ),
    ).toBe(1);
    expect(
      occurrencesUntil(
        { paidUntil: new Date('2026-09-20T00:00:00Z'), periodUnit: 'month', periodCount: 1 },
        from,
        to,
      ),
    ).toBe(1);
    expect(
      occurrencesUntil(
        { paidUntil: new Date('2026-10-05T00:00:00Z'), periodUnit: 'month', periodCount: 1 },
        from,
        to,
      ),
    ).toBe(0);
    expect(
      occurrencesUntil(
        { paidUntil: new Date('2026-09-29T12:00:00Z'), periodUnit: 'day', periodCount: 1 },
        from,
        new Date('2026-10-02T00:00:00Z'),
      ),
    ).toBe(3);
    expect(
      occurrencesUntil(
        { paidUntil: new Date('2026-09-20T00:00:00Z'), periodUnit: 'once', periodCount: 1 },
        from,
        to,
      ),
    ).toBe(1);
  });

  it('продление: период, дни, точная дата; разовую на период не продлить', () => {
    const p = new Date('2026-01-31T10:00:00Z');
    expect(extendTarget(p, { period: true }, 'month', 1)).toEqual(new Date('2026-02-28T10:00:00Z'));
    expect(extendTarget(p, { days: 3 }, 'month', 1)).toEqual(new Date('2026-02-03T10:00:00Z'));
    expect(extendTarget(p, { until: '2026-05-01T00:00:00Z' }, 'month', 1)).toEqual(
      new Date('2026-05-01T00:00:00Z'),
    );
    expect(extendTarget(p, { period: true }, 'once', 1)).toBeNull();
  });

  it('срок словами', () => {
    expect(dueInWords(new Date('2026-10-01T10:00:00Z'), now)).toBe('через 2 дня');
    expect(dueInWords(new Date('2026-09-29T14:00:00Z'), now)).toBe('через 5 часов');
    expect(dueInWords(new Date('2026-09-26T08:00:00Z'), now)).toBe('просрочено на 3 дня');
    expect(dueInWords(new Date('2026-09-28T08:00:00Z'), now)).toBe('просрочено на 1 день');
  });

  it('даты будущих оплат: просроченная — сейчас, дальше по периоду; разовая — один раз', () => {
    const from = new Date('2026-09-29T09:00:00Z');
    const to = new Date('2026-12-01T00:00:00Z');
    const monthly = occurrenceDates(
      { paidUntil: new Date('2026-09-20T09:00:00Z'), periodUnit: 'month', periodCount: 1 },
      from,
      to,
    );
    expect(monthly.map((o) => [o.at.toISOString().slice(0, 10), o.overdue])).toEqual([
      ['2026-09-29', true],
      ['2026-10-20', false],
      ['2026-11-20', false],
    ]);
    expect(
      occurrenceDates(
        { paidUntil: new Date('2026-10-05T00:00:00Z'), periodUnit: 'once', periodCount: 1 },
        from,
        to,
      ),
    ).toHaveLength(1);
  });
});
