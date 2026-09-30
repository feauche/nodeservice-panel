import {
  type BillingCurrency,
  type BillingDueState,
  type BillingItem,
  type BillingKind,
  billingDueInWords,
  formatMoney,
  formatRub,
} from '@nodeservice/shared';

/** «2 октября, 18:00»; другой год — с годом. */
export function formatDue(iso: string): string {
  const d = new Date(iso);
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return new Intl.DateTimeFormat('ru-RU', {
    day: 'numeric',
    month: 'long',
    ...(sameYear ? {} : { year: 'numeric' }),
    hour: '2-digit',
    minute: '2-digit',
  })
    .format(d)
    .replace(' в ', ', ')
    .replace(' г.,', ',');
}

/** «29 сен» для компактных мест. */
export const formatShortDate = (iso: string): string =>
  new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short' }).format(new Date(iso)).replace('.', '');

/** Московская дата YYYY-MM-DD: курс ЦБ устанавливается на неё, по ней же его хранит панель. */
export const moscowDate = (at: number | Date = Date.now()): string =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Moscow' }).format(at);

/**
 * Когда панель получила курс ЦБ, по календарю браузера: «Обновлено 14:00», «Обновлено вчера, 09:07»,
 * «Обновлено 27 сентября». Действует ли курс ещё, решает не эта подпись, а дата курса по Москве.
 */
export function ratesUpdatedLabel(fetchedAt: string, now = Date.now()): string {
  const d = new Date(fetchedAt);
  const today = new Date(now);
  const time = d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  const dayStart = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((dayStart(today) - dayStart(d)) / 86_400_000);
  if (days <= 0) return `Обновлено ${time}`;
  if (days === 1) return `Обновлено вчера, ${time}`;
  const date = new Intl.DateTimeFormat('ru-RU', {
    day: 'numeric',
    month: 'long',
    ...(d.getFullYear() === today.getFullYear() ? {} : { year: 'numeric' }),
  })
    .format(d)
    .replace(' г.', '');
  return `Обновлено ${date}`;
}

/** «сегодня» или «на 27 сентября», если ЦБ не ответил и курс не сегодняшний, — для «по курсу ЦБ …». */
export function rateDayPhrase(date: string | null | undefined, now = Date.now()): string {
  if (!date || date >= moscowDate(now)) return 'сегодня';
  return `на ${rateDay(date)}`;
}

/** Дата курса словами: «27 сентября». Полдень — чтобы часовой пояс браузера не сдвинул число. */
export const rateDay = (date: string): string =>
  new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long' }).format(new Date(`${date}T12:00:00`));

export const dueWords = (iso: string, now = Date.now()): string =>
  billingDueInWords(new Date(iso), new Date(now));

export const money = formatMoney;
/** Рубли целыми — для итогов и сумм «≈». */
export const rub = formatRub;

/** «≈ 904 ₽» для $ и €, пусто для рублей. */
export function rubHint(item: Pick<BillingItem, 'currency' | 'amountRubTodayMinor'>): string | null {
  if (item.currency === 'RUB' || item.amountRubTodayMinor === null) return null;
  return `≈ ${formatRub(item.amountRubTodayMinor)}`;
}

/** Цвет маячка и текста срока. */
export const DUE_DOT: Record<BillingDueState, string> = {
  overdue: 'bg-crit',
  today: 'bg-crit',
  soon: 'bg-warn',
  ok: 'bg-ok',
  archived: 'bg-text-3',
};
export const DUE_TEXT: Record<BillingDueState, string> = {
  overdue: 'text-crit',
  today: 'text-crit',
  soon: 'text-warn',
  ok: 'text-text-3',
  archived: 'text-text-3',
};
export const DUE_LABEL: Record<BillingDueState, string> = {
  overdue: 'Просрочено',
  today: 'Меньше суток до оплаты',
  soon: 'Скоро оплата',
  ok: 'Оплачено',
  archived: 'В архиве',
};

/** Цвет типа в статистике — как в витрине: серверы, аренда, домены, сертификаты, другое. */
export const KIND_COLOR: Record<BillingKind, string> = {
  server: 'var(--color-brand)',
  rent: 'var(--color-ai)',
  domain: 'var(--color-ok)',
  cert: 'var(--color-warn)',
  other: 'var(--color-text-3)',
};

export const CURRENCY_OPTIONS: ReadonlyArray<{ key: BillingCurrency; label: string }> = [
  { key: 'RUB', label: '₽ рубли' },
  { key: 'USD', label: '$ доллары' },
  { key: 'EUR', label: '€ евро' },
];

/** Для поля datetime-local: «2026-10-02T18:00» по местному времени. */
export function toLocalInput(iso: string): string {
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}
export const fromLocalInput = (v: string): string | null => {
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
};
