import { describe, expect, it } from 'vitest';
import { mbitPerSecond } from './node-card';

describe('скорость ноды', () => {
  it('переводит байты Remnawave в мегабиты в секунду', () => {
    // Одно правило панели: меньше 10 Мбит/с — один знак после запятой, иначе целые.
    expect(mbitPerSecond(12_500_000)).toBe('100');
    expect(mbitPerSecond(1_000_000)).toBe('8,0');
    expect(mbitPerSecond(1_200_000)).toBe('9,6');
    expect(mbitPerSecond(null)).toBe('—');
  });
});
