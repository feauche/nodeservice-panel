import { describe, expect, it } from 'vitest';
import { formatMbps, formatTraffic } from './overview-format';

describe('overview-format', () => {
  it('форматтеры трафика', () => {
    expect(formatMbps(1_000_000)).toBe('8.0');
    expect(formatTraffic(300_000_000)).toEqual({ value: '2.40', unit: 'Гбит/с' });
    expect(formatTraffic(2_000_000)).toEqual({ value: '16', unit: 'Мбит/с' });
    expect(formatTraffic(500_000)).toEqual({ value: '4.0', unit: 'Мбит/с' });
    expect(formatTraffic(null)).toEqual({ value: '—', unit: '' });
  });
});
