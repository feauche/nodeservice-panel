import { z } from 'zod';

/**
 * Биллинг (R8, витрина `billing-variants.html`): что и когда оплачивать — серверы, аренду у провайдера без
 * своего сервера в панели, домены, сертификаты и прочее. Деньги храним целыми в копейках/центах
 * (`amountMinor`), чтобы не было ошибок округления. Курс ЦБ РФ фиксируется в момент каждой оплаты:
 * статистика задним числом не пересчитывается, будущие суммы — по сегодняшнему курсу со знаком «≈».
 */

export const BILLING_KINDS = ['server', 'rent', 'domain', 'cert', 'other'] as const;
export const billingKindSchema = z.enum(BILLING_KINDS);
export type BillingKind = z.infer<typeof billingKindSchema>;
export const BILLING_KIND_LABELS: Record<BillingKind, string> = {
  server: 'Сервер',
  rent: 'Аренда',
  domain: 'Домен',
  cert: 'Сертификат',
  other: 'Другое',
};
export const BILLING_KIND_HINTS: Record<BillingKind, string> = {
  server: 'Сервер из NodeService у хостера.',
  rent: 'Платите провайдеру или арендодателю без своего сервера в панели — например, вход с белым IP.',
  domain: 'Регистрация домена.',
  cert: 'Сертификат: укажите, на каком сервере он развёрнут — подскажет, где продлевать.',
  other: 'Всё остальное: подписки, IP, резервные копии.',
};

export const BILLING_CURRENCIES = ['RUB', 'USD', 'EUR'] as const;
export const billingCurrencySchema = z.enum(BILLING_CURRENCIES);
export type BillingCurrency = z.infer<typeof billingCurrencySchema>;
export const BILLING_CURRENCY_SIGN: Record<BillingCurrency, string> = { RUB: '₽', USD: '$', EUR: '€' };

export const BILLING_PERIOD_UNITS = ['day', 'week', 'month', 'year', 'once'] as const;
export const billingPeriodUnitSchema = z.enum(BILLING_PERIOD_UNITS);
export type BillingPeriodUnit = z.infer<typeof billingPeriodUnitSchema>;

/** Готовые периоды для кнопок; «своё» — любое число дней/недель/месяцев/лет. */
export const BILLING_PERIOD_PRESETS: ReadonlyArray<{
  unit: BillingPeriodUnit;
  count: number;
  label: string;
}> = [
  { unit: 'day', count: 1, label: 'каждый день' },
  { unit: 'day', count: 3, label: 'каждые 3 дня' },
  { unit: 'week', count: 1, label: 'неделя' },
  { unit: 'day', count: 30, label: '30 дней' },
  { unit: 'month', count: 1, label: 'месяц' },
  { unit: 'month', count: 3, label: '3 месяца' },
  { unit: 'year', count: 1, label: 'год' },
  { unit: 'once', count: 1, label: 'разово' },
];

const plural = (n: number, forms: [string, string, string]) => {
  const a = Math.abs(n) % 100;
  const b = a % 10;
  if (a > 10 && a < 20) return forms[2];
  if (b > 1 && b < 5) return forms[1];
  if (b === 1) return forms[0];
  return forms[2];
};

/** «каждые 3 дня», «раз в месяц», «каждые 2 года», «разово». */
export function billingPeriodLabel(unit: BillingPeriodUnit, count: number): string {
  if (unit === 'once') return 'разово';
  const f: Record<Exclude<BillingPeriodUnit, 'once'>, [string, string, string]> = {
    day: ['день', 'дня', 'дней'],
    week: ['неделю', 'недели', 'недель'],
    month: ['месяц', 'месяца', 'месяцев'],
    year: ['год', 'года', 'лет'],
  };
  if (count === 1) return unit === 'day' ? 'каждый день' : `раз в ${f[unit][0]}`;
  return `каждые ${count} ${plural(count, f[unit])}`;
}

/** Следующая дата по периоду: месяц — то же число следующего месяца (с поправкой на короткие). */
export function addBillingPeriod(from: Date, unit: BillingPeriodUnit, count: number): Date {
  const d = new Date(from);
  if (unit === 'day') d.setUTCDate(d.getUTCDate() + count);
  else if (unit === 'week') d.setUTCDate(d.getUTCDate() + 7 * count);
  else if (unit === 'month' || unit === 'year') {
    const months = unit === 'month' ? count : 12 * count;
    const day = d.getUTCDate();
    d.setUTCDate(1);
    d.setUTCMonth(d.getUTCMonth() + months);
    const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
    d.setUTCDate(Math.min(day, last));
  }
  return d;
}

/** Сумма из копеек: «1 290 ₽», «€9.50», «$6». */
export function formatMoney(minor: number, currency: BillingCurrency): string {
  const v = minor / 100;
  if (currency === 'RUB')
    return `${v.toLocaleString('ru-RU', { minimumFractionDigits: v % 1 ? 2 : 0, maximumFractionDigits: 2 })} ₽`;
  return `${BILLING_CURRENCY_SIGN[currency]}${v.toLocaleString('en-US', { minimumFractionDigits: v % 1 ? 2 : 0, maximumFractionDigits: 2 })}`;
}

/** Рубли целыми: итоги и суммы «≈» по курсу — копейки там только мешают. */
export const formatRub = (minor: number): string => formatMoney(Math.round(minor / 100) * 100, 'RUB');

/** Срок: просрочено / сегодня / скоро (меньше 3 дней) / нормально / в архиве. */
export const BILLING_DUE_STATES = ['overdue', 'today', 'soon', 'ok', 'archived'] as const;
export type BillingDueState = (typeof BILLING_DUE_STATES)[number];

export const billingItemSchema = z.object({
  id: z.string().uuid(),
  kind: billingKindSchema,
  title: z.string(),
  providerId: z.string().uuid().nullable(),
  /** Сервер (для «Сервер») или серверы, где развёрнут сертификат; у аренды — необязательно. */
  serverIds: z.array(z.string().uuid()),
  domain: z.string().nullable(),
  amountMinor: z.number().int().min(0),
  currency: billingCurrencySchema,
  periodUnit: billingPeriodUnitSchema,
  periodCount: z.number().int().min(1),
  /** До какого момента оплачено — когда нужна следующая оплата. */
  paidUntil: z.string(),
  /** Автоплатёж у провайдера: в срок панель сама продлит и учтёт сумму. */
  autoCharge: z.boolean(),
  /** За сколько дней напоминать; null — как в настройках уведомлений. */
  remindDays: z.number().int().min(0).max(60).nullable(),
  note: z.string().nullable(),
  archivedAt: z.string().nullable(),
  createdAt: z.string(),
  // Считается на сервере:
  dueState: z.enum(BILLING_DUE_STATES),
  /** Сумма в рублях по сегодняшнему курсу (для $ и €); для рублей равна сумме. */
  amountRubTodayMinor: z.number().int().nullable(),
});
export type BillingItem = z.infer<typeof billingItemSchema>;

export const billingItemsResponseSchema = z.object({ items: z.array(billingItemSchema) });

const amountSchema = z.number().min(0).max(100_000_000);

/** Создание и изменение: сумма в рублях/долларах/евро (не в копейках) — удобнее для формы. */
export const billingItemUpsertSchema = z.object({
  kind: billingKindSchema,
  title: z.string().trim().min(1, 'Укажите название').max(120),
  providerId: z.string().uuid().nullable(),
  serverIds: z.array(z.string().uuid()).max(20),
  domain: z.string().trim().max(253).nullable(),
  amount: amountSchema,
  currency: billingCurrencySchema,
  periodUnit: billingPeriodUnitSchema,
  periodCount: z.number().int().min(1).max(1000),
  paidUntil: z.iso.datetime({ offset: true }),
  autoCharge: z.boolean(),
  remindDays: z.number().int().min(0).max(60).nullable(),
  note: z.string().trim().max(1000).nullable(),
});
export type BillingItemUpsert = z.infer<typeof billingItemUpsertSchema>;

/** «Продлить»: на период карточки, на N дней или до точной даты; с учётом суммы или только дата. */
export const billingExtendSchema = z
  .object({
    period: z.boolean().optional(),
    days: z.number().int().min(1).max(3650).optional(),
    until: z.iso.datetime({ offset: true }).optional(),
    /** Учесть оплату в статистике. */
    count: z.boolean(),
    amount: amountSchema.optional(),
  })
  .refine((v) => [v.period, v.days, v.until].filter((x) => x !== undefined && x !== false).length === 1, {
    message: 'Укажите одно: период карточки, число дней или дату.',
  });
export type BillingExtend = z.infer<typeof billingExtendSchema>;

export const billingPaymentSchema = z.object({
  id: z.string().uuid(),
  itemId: z.string().uuid(),
  paidAt: z.string(),
  /** Учтена ли сумма; false — только перенесли дату. */
  counted: z.boolean(),
  amountMinor: z.number().int(),
  currency: billingCurrencySchema,
  /** Курс ЦБ на день оплаты (рублей за единицу); для рублей 1. */
  rate: z.number(),
  amountRubMinor: z.number().int(),
  extendedFrom: z.string(),
  extendedTo: z.string(),
  actor: z.string().nullable(),
  /** Отменить можно, пока дата карточки не менялась после этого продления. */
  undoable: z.boolean(),
});
export type BillingPayment = z.infer<typeof billingPaymentSchema>;

export const billingExtendResponseSchema = z.object({
  item: billingItemSchema,
  payment: billingPaymentSchema,
});
export const billingPaymentsResponseSchema = z.object({ items: z.array(billingPaymentSchema) });
export const billingPaymentUpdateSchema = z.object({
  paidAt: z.iso.datetime({ offset: true }).optional(),
  amount: amountSchema.optional(),
});

export const BILLING_STAT_PERIODS = ['day', 'week', 'month', 'year'] as const;
export const billingStatPeriodSchema = z.enum(BILLING_STAT_PERIODS);
export type BillingStatPeriod = z.infer<typeof billingStatPeriodSchema>;

export const billingTotalSchema = z.object({
  /** Оплачено за календарный период, в рублях по курсу на день каждой оплаты. */
  spentRubMinor: z.number().int(),
  payments: z.number().int(),
  /** Сколько в исходных валютах. */
  byCurrency: z.array(z.object({ currency: billingCurrencySchema, amountMinor: z.number().int() })),
  /** Ещё ожидается до конца периода по сегодняшнему курсу (≈). */
  expectedRubMinor: z.number().int(),
  from: z.string(),
  to: z.string(),
});
export type BillingTotal = z.infer<typeof billingTotalSchema>;

export const billingSummarySchema = z.object({
  day: billingTotalSchema,
  week: billingTotalSchema,
  month: billingTotalSchema,
  year: billingTotalSchema,
  overdue: z.number().int(),
  dueToday: z.number().int(),
  next: z
    .object({
      itemId: z.string().uuid(),
      title: z.string(),
      paidUntil: z.string(),
      amountMinor: z.number().int(),
      currency: billingCurrencySchema,
    })
    .nullable(),
  /** Ближайшая оплата по каждому серверу — для метки в карточке сервера. */
  byServer: z.array(
    z.object({
      serverId: z.string().uuid(),
      itemId: z.string().uuid(),
      title: z.string(),
      paidUntil: z.string(),
      dueState: z.enum(BILLING_DUE_STATES),
      amountMinor: z.number().int(),
      currency: billingCurrencySchema,
    }),
  ),
  /** Курс ЦБ сегодня и дата курса (если свежий получить не удалось — последний известный). */
  rates: z.object({ USD: z.number().nullable(), EUR: z.number().nullable(), date: z.string().nullable() }),
});
export type BillingSummary = z.infer<typeof billingSummarySchema>;

export const billingStatsSchema = z.object({
  period: billingStatPeriodSchema,
  total: billingTotalSchema,
  /** Разбивка за выбранный период. */
  byProvider: z.array(
    z.object({ providerId: z.string().nullable(), name: z.string(), rubMinor: z.number().int() }),
  ),
  byKind: z.array(z.object({ kind: billingKindSchema, rubMinor: z.number().int() })),
  /** По месяцам выбранного года, с разбивкой по типам. */
  months: z.array(z.object({ month: z.number().int(), byKind: z.record(z.string(), z.number().int()) })),
});
export type BillingStats = z.infer<typeof billingStatsSchema>;

export const BILLING_PROBLEM = {
  notFound: 'urn:nodeservice:problem:billing-not-found',
  undo: 'urn:nodeservice:problem:billing-undo',
} as const;

export const billingArchiveSchema = z.object({ archived: z.boolean() });
export const billingListQuerySchema = z.object({ archived: z.enum(['0', '1']).optional() });
export const billingSummaryQuerySchema = z.object({ tz: z.string().max(64).optional() });
export const billingStatsQuerySchema = z.object({
  period: billingStatPeriodSchema.default('month'),
  tz: z.string().max(64).optional(),
});

const BILLING_DAY_MS = 86_400_000;

/** «через 2 дня», «сегодня в 12:00», «просрочено на 3 дня». Для текстов Джарвиса и Telegram. */
export function billingDueInWords(paidUntil: Date, now: Date): string {
  const ms = paidUntil.getTime() - now.getTime();
  const days = Math.floor(Math.abs(ms) / BILLING_DAY_MS);
  const hours = Math.floor(Math.abs(ms) / 3_600_000);
  const dayWord = (n: number) =>
    n % 10 === 1 && n % 100 !== 11
      ? 'день'
      : [2, 3, 4].includes(n % 10) && ![12, 13, 14].includes(n % 100)
        ? 'дня'
        : 'дней';
  const hourWord = (n: number) =>
    n % 10 === 1 && n % 100 !== 11
      ? 'час'
      : [2, 3, 4].includes(n % 10) && ![12, 13, 14].includes(n % 100)
        ? 'часа'
        : 'часов';
  if (ms <= 0)
    return days >= 1
      ? `просрочено на ${days} ${dayWord(days)}`
      : hours >= 1
        ? `просрочено на ${hours} ${hourWord(hours)}`
        : 'просрочено только что';
  // В будущее округляем: «через 1 день 23 часа» — это «через 2 дня».
  const ahead = Math.round(ms / BILLING_DAY_MS);
  if (ms >= 20 * 3_600_000) return `через ${Math.max(1, ahead)} ${dayWord(Math.max(1, ahead))}`;
  return hours >= 1 ? `через ${hours} ${hourWord(hours)}` : 'меньше чем через час';
}

/** Одна будущая оплата в прогнозе. */
export const billingForecastItemSchema = z.object({
  itemId: z.string().uuid(),
  title: z.string(),
  provider: z.string().nullable(),
  /** Когда платить; просроченная — «сейчас». */
  date: z.string(),
  overdue: z.boolean(),
  amountMinor: z.number().int(),
  currency: billingCurrencySchema,
  /** В рублях по сегодняшнему курсу; null — курса нет. */
  rubMinor: z.number().int().nullable(),
  /** Спишется сама (автоплатёж). */
  auto: z.boolean(),
});
export type BillingForecastItem = z.infer<typeof billingForecastItemSchema>;

/**
 * Прогноз оплат (витрина `billing-forecast-variants.html`, A): все будущие списания по активным оплатам,
 * в рублях по сегодняшнему курсу ЦБ (со знаком «≈»). Архив не учитывается.
 */
export const billingForecastSchema = z.object({
  next7: z.object({ rubMinor: z.number().int(), count: z.number().int() }),
  next30: z.object({ rubMinor: z.number().int(), count: z.number().int(), auto: z.number().int() }),
  /** С сегодняшнего дня до 1 января. */
  restOfYear: z.object({ rubMinor: z.number().int(), months: z.number().int() }),
  /** Сколько в год при нынешнем наборе оплат. */
  perYearRubMinor: z.number().int(),
  first: billingForecastItemSchema.nullable(),
  /** Ближайшие три календарные недели (пн–вс), первая — текущая. */
  weeks: z.array(
    z.object({
      from: z.string(),
      to: z.string(),
      rubMinor: z.number().int(),
      items: z.array(billingForecastItemSchema),
    }),
  ),
  /** Три прошлых месяца, текущий и три следующих: оплачено (по курсу дня оплаты) и прогноз. */
  months: z.array(
    z.object({
      year: z.number().int(),
      month: z.number().int(),
      paidRubMinor: z.number().int(),
      forecastRubMinor: z.number().int(),
    }),
  ),
  /** Есть $ или €, а курса ЦБ нет — суммы в рублях неполные. */
  rateMissing: z.boolean(),
});
export type BillingForecast = z.infer<typeof billingForecastSchema>;
