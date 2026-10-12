import { MONITORING_DEFAULTS } from '@nodeservice/shared';
import { describe, expect, it } from 'vitest';
import { dropDetected, memoryPercent, stableBaseline } from './fleet-monitor.logic.js';

const now = Date.now(),
  cfg = MONITORING_DEFAULTS;
describe('Условия мониторинга Remnawave', () => {
  it('игнорирует единичный пик и требует три исходных замера', () => {
    const samples = [100, 101, 99, 1000].map((online, i) => ({ online, at: now - (4 - i) * 60000 }));
    expect(stableBaseline(samples, now, cfg)).toBe(100);
    expect(stableBaseline(samples.slice(0, 2), now, cfg)).toBeNull();
  });
  it('не использует устаревший исходный онлайн', () => {
    expect(
      stableBaseline(
        [1, 2, 3].map((online) => ({ online, at: now - 600000 })),
        now,
        cfg,
      ),
    ).toBeNull();
  });
  it('ловит падение до нуля и 15 человек, но не малый исходный онлайн', () => {
    expect(dropDetected(0, 100, cfg)).toBe(true);
    expect(dropDetected(15, 100, cfg)).toBe(true);
    expect(dropDetected(0, 20, cfg)).toBe(false);
    expect(dropDetected(15, null, cfg)).toBe(false);
  });
  it('считает память из реальных байтов; отсутствие не становится нулём', () => {
    expect(memoryPercent({ memoryUsedBytes: 9, memoryTotalBytes: 10 } as never)).toBe(90);
    expect(memoryPercent({ memoryUsedBytes: 9, memoryTotalBytes: null } as never)).toBeNull();
  });
});
