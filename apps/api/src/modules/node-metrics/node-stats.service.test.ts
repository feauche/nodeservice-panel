import { describe, expect, it } from 'vitest';

import { downtimeWithin, hourWindow } from './node-stats.service.js';

describe('отчёт за период', () => {
  it('часы пика и тишины — четыре часа подряд, в том числе через полночь', () => {
    // Пик вечером 21–01, тише всего утром 06–10.
    const hourly = Array.from({ length: 24 }, (_, h) =>
      h >= 21 || h < 1 ? 900 : h >= 6 && h < 10 ? 100 : 500,
    );
    expect(hourWindow(hourly, 'max')).toEqual({ from: 21, to: 1 });
    expect(hourWindow(hourly, 'min')).toEqual({ from: 6, to: 10 });
    expect(hourWindow(Array(24).fill(null), 'max')).toBeNull();
  });

  it('простой считается только внутри периода; открытое событие — до конца периода', () => {
    const from = 1_000;
    const to = 10_000;
    expect(
      downtimeWithin(
        [
          { node: 'a', openedAt: 0, resolvedAt: 2_000 }, // началось до периода: 1 000
          { node: 'b', openedAt: 3_000, resolvedAt: 4_000 }, // целиком внутри: 1 000
          { node: 'c', openedAt: 9_000, resolvedAt: null }, // ещё открыто: 1 000
          { node: 'd', openedAt: 11_000, resolvedAt: 12_000 }, // после периода: 0
        ],
        from,
        to,
      ),
    ).toBe(3_000);
  });

  it('события одной ноды, наложенные друг на друга, не считаются дважды', () => {
    expect(
      downtimeWithin(
        [
          { node: 'a', openedAt: 1_000, resolvedAt: 4_000 },
          { node: 'a', openedAt: 2_000, resolvedAt: 3_000 },
          { node: 'a', openedAt: 3_500, resolvedAt: 5_000 },
          { node: 'b', openedAt: 2_000, resolvedAt: 3_000 },
          { node: null, openedAt: 2_000, resolvedAt: 3_000 },
          { node: null, openedAt: 2_000, resolvedAt: 3_000 },
        ],
        0,
        10_000,
      ),
    ).toBe(4_000 + 1_000 + 2_000);
  });
});
