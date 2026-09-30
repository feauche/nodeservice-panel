import { describe, expect, it } from 'vitest';

import { clipKeepingEnd, lowerFirst } from './text.js';

describe('lowerFirst', () => {
  it('строчной становится только первая буква обычного слова — сокращения внутри не портятся', () => {
    expect(lowerFirst('Похоже на блокировку IP из России')).toBe('похоже на блокировку IP из России');
    expect(lowerFirst('Похоже на блокировку ТСПУ')).toBe('похоже на блокировку ТСПУ');
    expect(lowerFirst('Сервер недоступен')).toBe('сервер недоступен');
  });
  it('сокращение в начале остаётся как есть', () => {
    expect(lowerFirst('SSH недоступен')).toBe('SSH недоступен');
    expect(lowerFirst('TLS-подключение прошло')).toBe('TLS-подключение прошло');
    expect(lowerFirst('')).toBe('');
  });
});

describe('clipKeepingEnd: длинный текст для колокольчика', () => {
  const line = (n: number) => `• Проверяющий ${n} — порт не отвечает совсем`;
  it('короткий текст не трогаем', () => {
    expect(clipKeepingEnd('Онлайн: 211 → 0\n\nВывод: всё плохо.', 1000)).toBe(
      'Онлайн: 211 → 0\n\nВывод: всё плохо.',
    );
  });
  it('длинный — режем середину по границе строки: начало и последний блок (вывод) остаются целыми', () => {
    const head = ['Онлайн: 211 → 0 (−100 %) за 5 минут', '', 'Из России:'];
    const tail = [
      '💳 Срок оплаты близко: Аренда «Guardora»: 2 500 ₽, оплачено до 30 сентября, 16:00 (UTC+6).',
      'Вероятнее всего: оплата закончилась чуть раньше срока, и сервер отключили — проверьте баланс.',
    ];
    const text = [...head, ...Array.from({ length: 40 }, (_, i) => line(i)), '', ...tail].join('\n');
    const out = clipKeepingEnd(text, 500);
    expect(out.length).toBeLessThanOrEqual(500);
    expect(out.startsWith('Онлайн: 211 → 0 (−100 %) за 5 минут\n\nИз России:\n• Проверяющий 0')).toBe(true);
    // Вывод об оплате стоит в самом конце — он не должен пропасть на полуслове.
    expect(out.endsWith(`\n…\n${tail.join('\n')}`)).toBe(true);
    // Строки не обрываются посередине.
    for (const l of out.split('\n')) expect(l === '…' || text.split('\n').includes(l), l).toBe(true);
  });
  it('последний блок сам длиннее предела — обычная обрезка с многоточием', () => {
    const text = `Начало.\n\n${'я'.repeat(800)}`;
    const out = clipKeepingEnd(text, 300);
    expect(out.length).toBe(300);
    expect(out.endsWith('…')).toBe(true);
  });
});
