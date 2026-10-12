import { describe, expect, it } from 'vitest';

import { minutesText } from './node-anomaly.logic.js';

describe('minutesText', () => {
  it('склоняет «минуту / минуты / минут»', () => {
    expect([1, 2, 5, 11, 12, 21, 22, 25].map(minutesText)).toEqual([
      '1 минуту',
      '2 минуты',
      '5 минут',
      '11 минут',
      '12 минут',
      '21 минуту',
      '22 минуты',
      '25 минут',
    ]);
  });
});
