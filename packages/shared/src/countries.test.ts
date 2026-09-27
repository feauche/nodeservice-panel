import { describe, expect, it } from 'vitest';

import {
  COMMON_COUNTRY_CODES,
  COUNTRY_CODES,
  countryChoiceSchema,
  countryCodeSchema,
  countryList,
  countryName,
  decideCountry,
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
  it('выбор в поле: автоматически или вручную с кодом', () => {
    expect(countryChoiceSchema.parse({ mode: 'auto' })).toEqual({ mode: 'auto' });
    expect(countryChoiceSchema.parse({ mode: 'manual', code: 'nl' })).toEqual({ mode: 'manual', code: 'NL' });
    expect(countryChoiceSchema.safeParse({ mode: 'manual' }).success).toBe(false);
    expect(countryChoiceSchema.safeParse({ mode: 'manual', code: 'ZZ' }).success).toBe(false);
  });
});

describe('решение по ответам геосервисов', () => {
  it('согласны не меньше 60 % ответивших, ответило не меньше четырёх — страна определена', () => {
    expect(decideCountry(['PL', 'PL', 'PL', 'BR', 'RU'])).toEqual({ code: 'PL', agree: 3, total: 5 });
    expect(decideCountry(['pl', 'PL', 'PL', 'PL'])).toEqual({ code: 'PL', agree: 4, total: 4 });
  });
  it('ответило мало: не определена, причина названа', () => {
    const r = decideCountry(['PL', 'PL', 'PL']);
    expect(r).toMatchObject({ code: null, total: 3 });
    expect('reason' in r && r.reason).toContain('Ответили только 3');
  });
  it('источники разошлись: не определена, показано, кто что ответил', () => {
    const r = decideCountry(['PL', 'PL', 'BR', 'BR', 'RU']);
    expect(r).toMatchObject({ code: null, agree: 2, total: 5 });
    expect('reason' in r && r.reason).toContain('PL 2, BR 2, RU 1');
  });
  it('мусорные ответы (не код страны) не считаются ответившими', () => {
    expect(decideCountry(['PL', 'PL', 'PL', 'PL', 'n/a', '', 'ZZ'])).toEqual({
      code: 'PL',
      agree: 4,
      total: 4,
    });
  });
});
