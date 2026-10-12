import { describe, expect, it } from 'vitest';

import {
  COMMON_COUNTRY_CODES,
  COUNTRY_CODES,
  countryCodeSchema,
  countryList,
  countryName,
} from './countries.js';

describe('страны', () => {
  it('в списке 249 уникальных кодов ISO, у каждого есть русское название', () => {
    expect(COUNTRY_CODES).toHaveLength(249);
    expect(new Set(COUNTRY_CODES).size).toBe(249);
    for (const c of COUNTRY_CODES) {
      const name = countryName(c);
      expect(name, c).not.toBe(c);
      expect(/[А-Яа-яЁё]/.test(name), `${c}: ${name}`).toBe(true);
    }
  });
  it('частые страны есть в списке; привычные названия вместо книжных', () => {
    for (const c of COMMON_COUNTRY_CODES) expect(COUNTRY_CODES).toContain(c);
    expect(countryName('US')).toBe('США');
    expect(countryName('pl')).toBe('Польша');
    expect(countryName('XX')).toBe('XX');
  });
  it('список отсортирован по русским названиям', () => {
    const names = countryList().map((c) => c.name);
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b, 'ru')));
  });
  it('код приводится к верхнему регистру, неверный отвергается', () => {
    expect(countryCodeSchema.parse(' pl ')).toBe('PL');
    expect(countryCodeSchema.safeParse('ZZ').success).toBe(false);
    expect(countryCodeSchema.safeParse('POL').success).toBe(false);
  });
});
