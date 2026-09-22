import { describe, expect, it } from 'vitest';

import { blockSecondsForSeries, retryAfterSeconds, shouldBlock } from './throttle.schedule.js';

describe('throttle schedule', () => {
  it('серии 1..4 → 30, 60, 300, 900; дальше — плато 900', () => {
    expect(blockSecondsForSeries(1)).toBe(30);
    expect(blockSecondsForSeries(2)).toBe(60);
    expect(blockSecondsForSeries(3)).toBe(300);
    expect(blockSecondsForSeries(4)).toBe(900);
    expect(blockSecondsForSeries(5)).toBe(900);
    expect(blockSecondsForSeries(100)).toBe(900);
  });

  it('некорректный номер серии не ломает расчёт', () => {
    expect(blockSecondsForSeries(0)).toBe(30);
    expect(blockSecondsForSeries(-3)).toBe(30);
  });

  it('пауза начинается ровно после 5 неудач', () => {
    expect(shouldBlock(4)).toBe(false);
    expect(shouldBlock(5)).toBe(true);
    expect(shouldBlock(6)).toBe(true);
  });

  it('Retry-After округляется вверх и не бывает нулём', () => {
    expect(retryAfterSeconds(0)).toBe(1);
    expect(retryAfterSeconds(1)).toBe(1);
    expect(retryAfterSeconds(29_001)).toBe(30);
  });
});
