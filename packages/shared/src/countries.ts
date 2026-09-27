import { z } from 'zod';

/**
 * Страна сервера. Справочника стран в панели нет: список фиксированный (ISO 3166-1 alpha-2, русские названия),
 * страну выбирают в поле сервера. Режим «автоматически» определяет её по IP сервера запросами панели к нескольким
 * публичным геосервисам; ручной выбор автоматика не перезаписывает.
 */

export const COUNTRY_CODES = [
  'AD',
  'AE',
  'AF',
  'AG',
  'AI',
  'AL',
  'AM',
  'AO',
  'AQ',
  'AR',
  'AS',
  'AT',
  'AU',
  'AW',
  'AX',
  'AZ',
  'BA',
  'BB',
  'BD',
  'BE',
  'BF',
  'BG',
  'BH',
  'BI',
  'BJ',
  'BL',
  'BM',
  'BN',
  'BO',
  'BQ',
  'BR',
  'BS',
  'BT',
  'BV',
  'BW',
  'BY',
  'BZ',
  'CA',
  'CC',
  'CD',
  'CF',
  'CG',
  'CH',
  'CI',
  'CK',
  'CL',
  'CM',
  'CN',
  'CO',
  'CR',
  'CU',
  'CV',
  'CW',
  'CX',
  'CY',
  'CZ',
  'DE',
  'DJ',
  'DK',
  'DM',
  'DO',
  'DZ',
  'EC',
  'EE',
  'EG',
  'EH',
  'ER',
  'ES',
  'ET',
  'FI',
  'FJ',
  'FK',
  'FM',
  'FO',
  'FR',
  'GA',
  'GB',
  'GD',
  'GE',
  'GF',
  'GG',
  'GH',
  'GI',
  'GL',
  'GM',
  'GN',
  'GP',
  'GQ',
  'GR',
  'GS',
  'GT',
  'GU',
  'GW',
  'GY',
  'HK',
  'HM',
  'HN',
  'HR',
  'HT',
  'HU',
  'ID',
  'IE',
  'IL',
  'IM',
  'IN',
  'IO',
  'IQ',
  'IR',
  'IS',
  'IT',
  'JE',
  'JM',
  'JO',
  'JP',
  'KE',
  'KG',
  'KH',
  'KI',
  'KM',
  'KN',
  'KP',
  'KR',
  'KW',
  'KY',
  'KZ',
  'LA',
  'LB',
  'LC',
  'LI',
  'LK',
  'LR',
  'LS',
  'LT',
  'LU',
  'LV',
  'LY',
  'MA',
  'MC',
  'MD',
  'ME',
  'MF',
  'MG',
  'MH',
  'MK',
  'ML',
  'MM',
  'MN',
  'MO',
  'MP',
  'MQ',
  'MR',
  'MS',
  'MT',
  'MU',
  'MV',
  'MW',
  'MX',
  'MY',
  'MZ',
  'NA',
  'NC',
  'NE',
  'NF',
  'NG',
  'NI',
  'NL',
  'NO',
  'NP',
  'NR',
  'NU',
  'NZ',
  'OM',
  'PA',
  'PE',
  'PF',
  'PG',
  'PH',
  'PK',
  'PL',
  'PM',
  'PN',
  'PR',
  'PS',
  'PT',
  'PW',
  'PY',
  'QA',
  'RE',
  'RO',
  'RS',
  'RU',
  'RW',
  'SA',
  'SB',
  'SC',
  'SD',
  'SE',
  'SG',
  'SH',
  'SI',
  'SJ',
  'SK',
  'SL',
  'SM',
  'SN',
  'SO',
  'SR',
  'SS',
  'ST',
  'SV',
  'SX',
  'SY',
  'SZ',
  'TC',
  'TD',
  'TF',
  'TG',
  'TH',
  'TJ',
  'TK',
  'TL',
  'TM',
  'TN',
  'TO',
  'TR',
  'TT',
  'TV',
  'TW',
  'TZ',
  'UA',
  'UG',
  'UM',
  'US',
  'UY',
  'UZ',
  'VA',
  'VC',
  'VE',
  'VG',
  'VI',
  'VN',
  'VU',
  'WF',
  'WS',
  'YE',
  'YT',
  'ZA',
  'ZM',
  'ZW',
] as const;
export type CountryCode = (typeof COUNTRY_CODES)[number];
const COUNTRY_SET: ReadonlySet<string> = new Set(COUNTRY_CODES);
export const isCountryCode = (v: string): v is CountryCode => COUNTRY_SET.has(v);

export const countryCodeSchema = z
  .string()
  .trim()
  .transform((v) => v.toUpperCase())
  .refine(isCountryCode, 'Неизвестный код страны')
  .transform((v) => v as CountryCode);

/** Страны парка владельца: в списке они идут первыми, группой «Частые». */
export const COMMON_COUNTRY_CODES: readonly CountryCode[] = ['RU', 'NL', 'DE', 'FI', 'PL', 'US'];

/** Как в быту называют страны, у которых название Intl длинное или книжное. */
const NAME_OVERRIDES: Partial<Record<CountryCode, string>> = {
  US: 'США',
  KR: 'Южная Корея',
  KP: 'Северная Корея',
  HK: 'Гонконг',
  CD: 'ДР Конго',
  CG: 'Республика Конго',
  MM: 'Мьянма',
  PS: 'Палестина',
  CI: 'Кот-д’Ивуар',
};

let names: Intl.DisplayNames | null = null;
/** Русское название страны по коду; неизвестный код возвращается как есть. */
export function countryName(code: string): string {
  const c = code.toUpperCase();
  if (isCountryCode(c) && NAME_OVERRIDES[c]) return NAME_OVERRIDES[c] as string;
  try {
    names ??= new Intl.DisplayNames(['ru'], { type: 'region' });
    return names.of(c) ?? c;
  } catch {
    return c;
  }
}

/** Все страны по алфавиту русских названий; частые отдельно (порядок как в COMMON_COUNTRY_CODES). */
export function countryList(): Array<{ code: CountryCode; name: string }> {
  return [...COUNTRY_CODES]
    .map((code) => ({ code, name: countryName(code) }))
    .sort((a, b) => a.name.localeCompare(b.name, 'ru'));
}

/** Режим: `auto` — панель определяет по IP сервера; `manual` — страну выбрал человек. */
export const COUNTRY_SOURCES = ['auto', 'manual'] as const;
export const countrySourceSchema = z.enum(COUNTRY_SOURCES);
export type CountrySource = z.infer<typeof countrySourceSchema>;

/** Ход автоопределения: none — не запускалось, detecting — идёт, ok — есть результат, failed — не вышло. */
export const COUNTRY_STATUSES = ['none', 'detecting', 'ok', 'failed'] as const;
export const countryStatusSchema = z.enum(COUNTRY_STATUSES);
export type CountryStatus = z.infer<typeof countryStatusSchema>;

export const COUNTRY_STATUS_LABELS: Record<CountryStatus, string> = {
  none: 'ещё не определялась',
  detecting: 'идёт определение',
  ok: 'определена',
  failed: 'не удалось определить',
};

export const serverCountrySchema = z.object({
  /** Код страны; null — не задана и не определена. */
  code: z.string().nullable(),
  source: countrySourceSchema,
  status: countryStatusSchema,
  /** Сколько источников согласились с ответом и сколько ответило (только для автоопределения). */
  agree: z.number().int().min(0).nullable(),
  total: z.number().int().min(0).nullable(),
  checkedAt: z.iso.datetime().nullable(),
  /** Пояснение к состоянию: почему не определилась, что ответили источники. */
  note: z.string().nullable(),
});
export type ServerCountry = z.infer<typeof serverCountrySchema>;

export const DEFAULT_SERVER_COUNTRY: ServerCountry = {
  code: null,
  source: 'auto',
  status: 'none',
  agree: null,
  total: null,
  checkedAt: null,
  note: null,
};

/** Что просит поле «Страна»: `auto` — «Определять автоматически», `manual` — выбранная страна. */
export const countryChoiceSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('auto') }),
  z.object({ mode: z.literal('manual'), code: countryCodeSchema }),
]);
export type CountryChoice = z.input<typeof countryChoiceSchema>;

/** Пороги решения по геосервисам: сколько источников должно ответить и какая доля должна согласиться. */
export const GEO_MIN_ANSWERS = 4;
export const GEO_MIN_AGREE_SHARE = 0.6;
/** Сколько проверок подряд должны показать другую страну, чтобы автоматика сменила уже определённую. */
export const GEO_CONFIRMATIONS = 2;

/** Вывод по ответам источников: страна, если хватает ответивших и согласных, иначе null с причиной. */
export function decideCountry(
  answers: ReadonlyArray<string>,
):
  | { code: string; agree: number; total: number }
  | { code: null; total: number; agree: number; reason: string } {
  const valid = answers.map((a) => a.trim().toUpperCase()).filter(isCountryCode);
  const total = valid.length;
  if (total < GEO_MIN_ANSWERS)
    return {
      code: null,
      total,
      agree: 0,
      reason: `Ответили только ${total} источников из необходимых ${GEO_MIN_ANSWERS}.`,
    };
  const tally = new Map<string, number>();
  for (const c of valid) tally.set(c, (tally.get(c) ?? 0) + 1);
  const [code, agree] = [...tally.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0] as [
    string,
    number,
  ];
  if (agree / total < GEO_MIN_AGREE_SHARE)
    return {
      code: null,
      total,
      agree,
      reason: `Источники разошлись: ${[...tally.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([c, n]) => `${c} ${n}`)
        .join(', ')}.`,
    };
  return { code, agree, total };
}
