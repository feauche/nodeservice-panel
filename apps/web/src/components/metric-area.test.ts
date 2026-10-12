import { describe, expect, it } from 'vitest';
import { gapRanges } from './metric-area';

describe('серые полосы «нет данных»', () => {
  const times = [0, 1, 2, 3, 4, 5, 6].map((m) => m * 60_000);
  it('полоса — от последней точки с данными до следующей; пропуск одного ряда — не перерыв', () => {
    const series = [
      { key: 'rx', name: 'Приём', color: '', values: [1, 2, null, null, 5, 6, null] },
      { key: 'tx', name: 'Отдача', color: '', values: [1, 2, null, null, 5, null, 7] },
    ];
    // Пустые обе линии — минуты 2 и 3; в минуте 5 и 6 у одной из линий значение есть.
    expect(gapRanges(times, series)).toEqual([[60_000, 240_000]]);
  });
  it('пусто в начале или в конце — полоса до края графика', () => {
    const series = [{ key: 'v', name: 'Онлайн', color: '', values: [null, null, 3, 4, 5, null, null] }];
    expect(gapRanges(times, series)).toEqual([
      [0, 120_000],
      [240_000, 360_000],
    ]);
  });
});
