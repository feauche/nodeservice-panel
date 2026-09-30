import { describe, expect, it } from 'vitest';

import {
  autoRenewedFact,
  buildPaymentWindow,
  PAYMENT_WINDOW_MS,
  type PaymentEntry,
  paymentFact,
  paymentFactLine,
  paymentWindowFor,
} from './payment-window.js';

const OMSK = 'Asia/Omsk';
// 15:56 в Омске — момент, когда у владельца упал онлайн, а оплата аренды кончалась в 16:00.
const NOW = new Date('2026-09-30T09:56:00Z');
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const hours = (h: number) => new Date(NOW.getTime() + h * HOUR);

const entry = (over: Partial<PaymentEntry> = {}): PaymentEntry => ({
  kind: 'rent',
  kindLabel: 'Аренда',
  title: 'Guardora',
  provider: null,
  amount: '2 500 ₽',
  paidUntil: new Date('2026-09-30T10:00:00Z'),
  autoCharge: false,
  periodMs: 30 * DAY,
  ...over,
});

describe('окно оплаты', () => {
  it('окно — сутки, но не больше четверти периода оплаты', () => {
    expect(PAYMENT_WINDOW_MS).toBe(DAY);
    expect(paymentWindowFor(30 * DAY)).toBe(DAY);
    expect(paymentWindowFor(7 * DAY)).toBe(DAY);
    // Оплата «каждый день» не должна быть в окне всегда.
    expect(paymentWindowFor(DAY)).toBe(6 * HOUR);
    expect(paymentWindowFor(3 * DAY)).toBe(18 * HOUR);
    // Разовая оплата — обычные сутки.
    expect(paymentWindowFor(null)).toBe(DAY);
  });

  it('факт об оплате: срок — в поясе панели и с подписью пояса; «через час» — отдельно, в текст дела не идёт', () => {
    const f = paymentFact(entry(), NOW, OMSK);
    expect(f).toEqual({
      kind: 'rent',
      text: 'Аренда «Guardora»: 2 500 ₽, оплачено до 30 сентября, 16:00 (UTC+6)',
      when: 'меньше чем через час',
      autoCharge: false,
    });
    // Для Джарвиса срок словами добавляется — он считается заново при каждом разборе.
    expect(paymentFactLine(f)).toBe(
      'Аренда «Guardora»: 2 500 ₽, оплачено до 30 сентября, 16:00 (UTC+6) — меньше чем через час',
    );
    expect(
      paymentFactLine(
        paymentFact(
          entry({
            kind: 'server',
            kindLabel: 'Сервер',
            title: 'DE-1 Falkenstein',
            provider: 'Hetzner',
            amount: '€4.51',
            paidUntil: hours(5),
            autoCharge: true,
          }),
          NOW,
          'Europe/Moscow',
        ),
      ),
    ).toBe(
      'Сервер «DE-1 Falkenstein» у Hetzner: €4.51, оплачено до 30 сентября, 17:56 (МСК) — через 5 часов (включён автоплатёж)',
    );
    expect(paymentFactLine(paymentFact(entry({ paidUntil: hours(-15) }), NOW, OMSK))).toBe(
      'Аренда «Guardora»: 2 500 ₽, оплачено до 30 сентября, 00:56 (UTC+6) — просрочено на 15 часов',
    );
  });

  it('просрочено, срок в окне и остальное — по отдельности; ближайший из остальных назван', () => {
    const w = buildPaymentWindow(
      [
        entry({ title: 'Через месяц', paidUntil: hours(24 * 30) }),
        entry({ title: 'Через 3 дня', paidUntil: hours(72) }),
        entry({ title: 'Через 5 часов', paidUntil: hours(5) }),
        entry({ title: 'Просрочена', paidUntil: hours(-2) }),
        entry({ title: 'Ровно сутки', paidUntil: hours(24) }),
        entry({ title: 'Сутки и минута', paidUntil: new Date(hours(24).getTime() + 60_000) }),
      ],
      [],
      NOW,
      OMSK,
    );
    expect(w.total).toBe(6);
    expect(w.overdue.map((f) => f.text)).toEqual([
      'Аренда «Просрочена»: 2 500 ₽, оплачено до 30 сентября, 13:56 (UTC+6)',
    ]);
    expect(w.overdue[0]?.when).toBe('просрочено на 2 часа');
    expect(w.dueSoon.map((f) => f.text.split('»')[0])).toEqual([
      'Аренда «Через 5 часов',
      'Аренда «Ровно сутки',
    ]);
    expect(w.next).toContain('«Сутки и минута»');
    expect(w.next).toContain('— через 1 день');
    expect(w.autoRenewed).toEqual([]);
  });

  it('вид оплаты сохраняется в факте: по нему решается, может ли оплата объяснить сбой', () => {
    const w = buildPaymentWindow(
      [
        entry({ kind: 'cert', kindLabel: 'Сертификат', title: 'certwarden', paidUntil: hours(10) }),
        entry({ kind: 'server', kindLabel: 'Сервер', title: 'DE-1', paidUntil: hours(3) }),
      ],
      [],
      NOW,
      OMSK,
    );
    expect(w.dueSoon.map((f) => f.kind)).toEqual(['server', 'cert']);
    expect([w.total, w.paying]).toEqual([2, 1]);
    // К серверу привязан только сертификат — оплата самого сервера не заведена: срока панель не знает.
    const certOnly = buildPaymentWindow(
      [entry({ kind: 'cert', kindLabel: 'Сертификат', title: 'certwarden', paidUntil: hours(24 * 150) })],
      [],
      NOW,
      OMSK,
    );
    expect([certOnly.total, certOnly.paying]).toEqual([1, 0]);
  });

  it('оплата «каждый день»: близким считается срок только в последние шесть часов', () => {
    const daily = (h: number) => entry({ title: 'RU-1', periodMs: DAY, paidUntil: hours(h) });
    expect(buildPaymentWindow([daily(12)], [], NOW, OMSK).dueSoon).toEqual([]);
    expect(buildPaymentWindow([daily(12)], [], NOW, OMSK).next).toContain('«RU-1»');
    expect(buildPaymentWindow([daily(5)], [], NOW, OMSK).dueSoon).toHaveLength(1);
    // И автопродление суточной оплаты «свежее» только шесть часов.
    const auto = daily(20);
    expect(buildPaymentWindow([auto], [{ entry: auto, at: hours(-4) }], NOW, OMSK).autoRenewed).toHaveLength(
      1,
    );
    expect(buildPaymentWindow([auto], [{ entry: auto, at: hours(-7) }], NOW, OMSK).autoRenewed).toEqual([]);
  });

  it('оплат у сервера нет — пусто и без «ближайшего срока»', () => {
    expect(buildPaymentWindow([], [], NOW, OMSK)).toEqual({
      overdue: [],
      dueSoon: [],
      autoRenewed: [],
      next: null,
      total: 0,
      paying: 0,
    });
  });

  it('автоплатёж за последние сутки: панель продлила срок сама и не знает, прошло ли списание', () => {
    const auto = entry({
      kind: 'server',
      kindLabel: 'Сервер',
      title: 'DE-1',
      provider: 'Hetzner',
      amount: '€4.51',
      paidUntil: hours(24 * 30 - 3),
      autoCharge: true,
    });
    expect(autoRenewedFact(auto, hours(-3), NOW, OMSK)).toBe(
      'Сервер «DE-1» у Hetzner: €4.51 — автоплатёж, срок продлён 30 сентября, 12:56 (UTC+6); прошло ли списание у провайдера, панель не знает',
    );
    const w = buildPaymentWindow([auto], [{ entry: auto, at: hours(-3) }], NOW, OMSK);
    expect(w.autoRenewed).toHaveLength(1);
    expect(w.overdue).toEqual([]);
    expect(w.dueSoon).toEqual([]);
    // Продление старше суток уже не в окне.
    expect(buildPaymentWindow([auto], [{ entry: auto, at: hours(-25) }], NOW, OMSK).autoRenewed).toEqual([]);
  });
});
