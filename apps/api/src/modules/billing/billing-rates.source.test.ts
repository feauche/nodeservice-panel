import { describe, expect, it } from 'vitest';

import { parseCbrJson, parseCbrXml } from './billing-rates.source.js';

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
});
