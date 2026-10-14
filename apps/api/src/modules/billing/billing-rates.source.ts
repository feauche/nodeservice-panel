import { fetch as undiciFetch } from 'undici';

/** Курс ЦБ РФ на дату: рублей за 1 $ и 1 € и дата, на которую ЦБ установил курс. */
export interface CbrRates {
  usd: number;
  eur: number;
  /** YYYY-MM-DD */
  date: string;
}

/** Источник курсов. В тестах подменяется (BILLING_RATES_SOURCE) — наружу ходит только настоящий. */
export interface BillingRatesSource {
  /** Курс на дату `date` (YYYY-MM-DD); null — получить не удалось. */
  fetch(date: string): Promise<CbrRates | null>;
}
export const BILLING_RATES_SOURCE = Symbol('BILLING_RATES_SOURCE');

const TIMEOUT_MS = 10_000;

/** Дата по Москве (курс ЦБ устанавливается на московскую дату): YYYY-MM-DD. */
export const moscowDate = (at: Date): string =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Moscow' }).format(at);

/** Разбор XML_daily.asp: `<CharCode>USD</CharCode><Nominal>1</Nominal>…<Value>81,1234</Value>`. */
export function parseCbrXml(xml: string): CbrRates | null {
  const date = /ValCurs[^>]*Date="(\d{2})\.(\d{2})\.(\d{4})"/.exec(xml);
  const pick = (code: string): number | null => {
    const m = new RegExp(
      `<CharCode>${code}</CharCode>\\s*<Nominal>(\\d+)</Nominal>[\\s\\S]*?<Value>([\\d,.]+)</Value>`,
    ).exec(xml);
    if (!m) return null;
    const v = Number((m[2] ?? '').replace(',', '.')) / Number(m[1]);
    return Number.isFinite(v) && v > 0 ? v : null;
  };
  const usd = pick('USD');
  const eur = pick('EUR');
  if (!date || usd === null || eur === null) return null;
  return { usd, eur, date: `${date[3]}-${date[2]}-${date[1]}` };
}

/** Разбор зеркала cbr-xml-daily.ru: `{ Date, Valute: { USD: { Value, Nominal } } }`. */
export function parseCbrJson(json: unknown): CbrRates | null {
  const j = json as { Date?: string; Valute?: Record<string, { Value?: number; Nominal?: number }> };
  const usd = j.Valute?.USD;
  const eur = j.Valute?.EUR;
  if (!j.Date || !usd?.Value || !eur?.Value) return null;
  return {
    usd: usd.Value / (usd.Nominal || 1),
    eur: eur.Value / (eur.Nominal || 1),
    date: j.Date.slice(0, 10),
  };
}

/** Официальный сайт ЦБ, при сбое — зеркало cbr-xml-daily.ru (архив по дате или сегодняшний курс). */
export class HttpCbrRatesSource implements BillingRatesSource {
  async fetch(date: string): Promise<CbrRates | null> {
    const [y, m, d] = date.split('-');
    try {
      const res = await undiciFetch(`https://www.cbr.ru/scripts/XML_daily.asp?date_req=${d}/${m}/${y}`, {
        signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: { 'user-agent': 'Mozilla/5.0 NodeService' },
      });
      if (res.ok) {
        const xml = new TextDecoder('windows-1251').decode(await res.arrayBuffer());
        const r = parseCbrXml(xml);
        if (r) return r;
      }
    } catch {
      // ниже — зеркало
    }
    // «Сегодня» — по Москве: с 00:00 до 03:00 МСК дата по UTC ещё вчерашняя, и общий файл зеркала не спрашивался.
    const today = moscowDate(new Date()) === date;
    for (const url of [
      `https://www.cbr-xml-daily.ru/archive/${y}/${m}/${d}/daily_json.js`,
      ...(today ? ['https://www.cbr-xml-daily.ru/daily_json.js'] : []),
    ]) {
      const r = await mirrorRates(url, date);
      if (r) return r;
    }
    return null;
  }
}

/**
 * Курс из файла зеркала, действующий на дату. Вечером общий файл уже содержит курс на завтра — тогда берём
 * предыдущий файл (PreviousURL): это и есть курс, действующий сегодня. Курс на дату позже запрошенной не отдаём.
 */
export async function mirrorRates(
  url: string,
  date: string,
  get: (url: string) => Promise<{ ok: boolean; json(): Promise<unknown> }> = (u) =>
    undiciFetch(u, { signal: AbortSignal.timeout(TIMEOUT_MS) }),
  hops = 2,
): Promise<CbrRates | null> {
  try {
    const res = await get(url);
    if (!res.ok) return null;
    const json = (await res.json()) as { PreviousURL?: string };
    const r = parseCbrJson(json);
    if (!r) return null;
    if (r.date <= date) return r;
    if (hops <= 0 || !json.PreviousURL) return null;
    const previous = json.PreviousURL.startsWith('//') ? `https:${json.PreviousURL}` : json.PreviousURL;
    return mirrorRates(previous, date, get, hops - 1);
  } catch {
    return null;
  }
}
