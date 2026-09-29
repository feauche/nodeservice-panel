import { describe, expect, it } from 'vitest';

import { avgOf, coveredSeconds, peakOf } from './fleet-stats.logic.js';

describe('статистика парка — расчёты', () => {
  it('простой считается один раз при пересечении и обрезается по периоду', () => {
    expect(
      coveredSeconds(
        [
          [0, 10_000],
          [5_000, 20_000],
          [30_000, 40_000],
        ],
        0,
        100_000,
      ),
    ).toBe(30);
    expect(coveredSeconds([[-10_000, 10_000]], 0, 100_000)).toBe(10);
    expect(coveredSeconds([], 0, 1)).toBe(0);
  });
  it('пик и среднее', () => {
    expect(
      peakOf([
        [1, 5],
        [2, 9],
        [3, Number.NaN],
      ]),
    ).toEqual({ value: 9, at: 2 });
    expect(peakOf([])).toBeNull();
    expect(avgOf([2, 4, Number.NaN])).toBe(3);
    expect(avgOf([])).toBeNull();
  });
});
