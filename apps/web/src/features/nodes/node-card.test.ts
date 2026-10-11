import { describe, expect, it } from 'vitest';
import { mbitPerSecond } from './node-card';

describe('скорость ноды', () => {
  it('переводит байты Remnawave в мегабиты в секунду', () => {
    expect(mbitPerSecond(12_500_000)).toBe('100');
    expect(mbitPerSecond(1_000_000)).toBe('8');
    expect(mbitPerSecond(null)).toBe('—');
  });
});
