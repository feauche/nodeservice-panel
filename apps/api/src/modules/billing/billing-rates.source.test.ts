import { describe, expect, it } from 'vitest';

import { mirrorRates, moscowDate, parseCbrJson, parseCbrXml } from './billing-rates.source.js';

describe('курсы ЦБ', () => {
  it('XML ЦБ: запятая, номинал, дата', () => {
    const xml = `<?xml version="1.0"?><ValCurs Date="29.09.2026" name="Foreign Currency Market">
      <Valute ID="R01235"><NumCode>840</NumCode><CharCode>USD</CharCode><Nominal>1</Nominal><Name>Доллар США</Name><Value>81,5025</Value><VunitRate>81,5025</VunitRate></Valute>
      <Valute ID="R01239"><NumCode>978</NumCode><CharCode>EUR</CharCode><Nominal>1</Nominal><Name>Евро</Name><Value>95,2</Value></Valute>
    </ValCurs>`;
    expect(parseCbrXml(xml)).toEqual({ usd: 81.5025, eur: 95.2, date: '2026-09-29' });
    expect(parseCbrXml('<ValCurs Date="29.09.2026"></ValCurs>')).toBeNull();
  });

  it('зеркало cbr-xml-daily', () => {
    expect(
      parseCbrJson({
        Date: '2026-09-29T11:30:00+03:00',
        Valute: { USD: { Value: 81.5, Nominal: 1 }, EUR: { Value: 95, Nominal: 1 } },
      }),
    ).toEqual({ usd: 81.5, eur: 95, date: '2026-09-29' });
    expect(parseCbrJson({})).toBeNull();
  });

  it('дата курса — по Москве: в 00:30 МСК уже новый день, хотя по UTC ещё вчера', () => {
    expect(moscowDate(new Date('2026-10-13T21:30:00Z'))).toBe('2026-10-14');
  });

  it('вечером зеркало уже с завтрашним курсом — берётся предыдущий файл, завтрашний не выдаётся за сегодняшний', async () => {
    const day = (date: string, value: number, prev?: string) => ({
      Date: `${date}T11:30:00+03:00`,
      ...(prev ? { PreviousURL: prev } : {}),
      Valute: { USD: { Value: value, Nominal: 1 }, EUR: { Value: value + 10, Nominal: 1 } },
    });
    const files: Record<string, unknown> = {
      'https://mirror/daily.js': day('2026-10-14', 82, '//mirror/archive/13.js'),
      'https://mirror/archive/13.js': day('2026-10-13', 81),
    };
    const get = async (url: string) => ({ ok: url in files, json: async () => files[url] });
    expect(await mirrorRates('https://mirror/daily.js', '2026-10-13', get)).toEqual({
      usd: 81,
      eur: 91,
      date: '2026-10-13',
    });
    expect(await mirrorRates('https://mirror/daily.js', '2026-10-14', get)).toMatchObject({ usd: 82 });
    const noPrevious = async () => ({ ok: true, json: async () => day('2026-10-14', 82) });
    expect(await mirrorRates('https://mirror/x', '2026-10-13', noPrevious)).toBeNull();
  });
});
