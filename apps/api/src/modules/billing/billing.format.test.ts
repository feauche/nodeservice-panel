import { describe, expect, it } from 'vitest';

import { formatBillingMessage } from './billing.format.js';

describe('сообщение биллинга в Telegram', () => {
  const base = {
    kind: 'server' as const,
    title: 'DE-1 Falkenstein',
    provider: 'Hetzner',
    domain: null,
    amountMinor: 451,
    currency: 'EUR' as const,
    amountRubMinor: 46_800,
    periodUnit: 'month' as const,
    periodCount: 1,
    paidUntil: new Date('2026-10-01T09:00:00Z'),
    servers: [{ name: 'DE-1', down: false }],
    note: null,
    now: new Date('2026-09-29T09:00:00Z'),
  };

  it('скоро оплата: сумма, курс, срок, период', () => {
    const t = formatBillingMessage({ ...base, state: 'soon' });
    expect(t).toContain('💳 <b>Скоро оплата — через 2 дня</b>');
    expect(t).toContain('<b>Hetzner</b> · DE-1 Falkenstein');
    expect(t).toContain('<b>€4.51</b>');
    expect(t).toContain('≈ 468 ₽ по курсу ЦБ');
    expect(t).toContain('1 октября, 12:00</b> (МСК)');
    expect(formatBillingMessage({ ...base, state: 'soon', timeZone: 'Asia/Omsk' })).toContain(
      '1 октября, 15:00</b> (UTC+6)',
    );
    expect(t).toContain('раз в месяц');
    expect(t).not.toContain('недоступен');
  });

  it('просрочено и сервер лежит — подсказываем причину', () => {
    const t = formatBillingMessage({
      ...base,
      state: 'overdue',
      paidUntil: new Date('2026-09-28T09:00:00Z'),
      servers: [{ name: 'DE-1', down: true }],
    });
    expect(t).toContain('🔴 <b>Оплата просрочена на 1 день</b>');
    expect(t).toContain('DE-1 недоступен</b> — вероятно, из-за неоплаты');
  });

  it('сертификат — «Развёрнут на»', () => {
    const t = formatBillingMessage({
      ...base,
      kind: 'cert',
      state: 'soon',
      currency: 'RUB',
      amountMinor: 0,
      servers: [
        { name: 'DE-1', down: false },
        { name: 'NL-2', down: false },
      ],
    });
    expect(t).toContain('Развёрнут на: DE-1, NL-2');
  });
});
