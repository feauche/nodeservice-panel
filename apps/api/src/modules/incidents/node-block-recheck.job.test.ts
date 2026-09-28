import { describe, expect, it } from 'vitest';

import { baselineFromDetail, recoverThreshold } from './node-block-recheck.job.js';

describe('перепроверка падения онлайна', () => {
  it('онлайн до падения берётся из дела', () => {
    expect(baselineFromDetail('Онлайн: 396 → 0 (−100 %) за 5 минут\n\nИз России:')).toBe(396);
    expect(baselineFromDetail('без онлайна')).toBeNull();
  });

  it('«в норме» — половина прежнего, но не меньше минимальной базы', () => {
    expect(recoverThreshold(396)).toBe(198);
    expect(recoverThreshold(12)).toBe(10);
    expect(recoverThreshold(null)).toBe(10);
  });
});
