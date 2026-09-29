/** «42,3 МБ», «4 КБ», «1,2 ГБ». */
export function formatSize(bytes: number | null | undefined): string {
  if (bytes == null) return '—';
  const units = ['Б', 'КБ', 'МБ', 'ГБ', 'ТБ'];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  const digits = i === 0 || v >= 100 ? 0 : 1;
  return `${v.toLocaleString('ru-RU', { maximumFractionDigits: digits })} ${units[i]}`;
}

function dayKey(d: Date, tz: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
}

/** «Сегодня, 04:00», «Вчера, 17:42», «Завтра, 04:00», «28 сентября, 04:00» — по часовому поясу панели. */
export function formatWhen(iso: string, tz: string, now = new Date()): string {
  const d = new Date(iso);
  const safeTz = (() => {
    try {
      new Intl.DateTimeFormat('ru', { timeZone: tz });
      return tz;
    } catch {
      return undefined;
    }
  })();
  const time = new Intl.DateTimeFormat('ru-RU', {
    timeZone: safeTz,
    hour: '2-digit',
    minute: '2-digit',
  }).format(d);
  const key = dayKey(d, safeTz ?? 'UTC');
  const shift = (days: number) => dayKey(new Date(now.getTime() + days * 86_400_000), safeTz ?? 'UTC');
  if (key === shift(0)) return `Сегодня, ${time}`;
  if (key === shift(-1)) return `Вчера, ${time}`;
  if (key === shift(1)) return `Завтра, ${time}`;
  const sameYear = key.slice(0, 4) === shift(0).slice(0, 4);
  const date = new Intl.DateTimeFormat('ru-RU', {
    timeZone: safeTz,
    day: 'numeric',
    month: 'long',
    ...(sameYear ? {} : { year: 'numeric' }),
  }).format(d);
  return `${date}, ${time}`;
}

const WEEKDAYS_IN = [
  '',
  'по понедельникам',
  'по вторникам',
  'по средам',
  'по четвергам',
  'по пятницам',
  'по субботам',
  'по воскресеньям',
];

export function scheduleWords(s: {
  auto: boolean;
  frequency: 'day' | 'week';
  weekday: number;
  time: string;
}): string {
  if (!s.auto) return 'расписание выключено';
  return s.frequency === 'day'
    ? `каждый день в ${s.time}`
    : `раз в неделю, ${WEEKDAYS_IN[s.weekday] ?? ''}, в ${s.time}`;
}

/** Склонение: 1 копия, 2 копии, 5 копий. */
export function plural(n: number, one: string, few: string, many: string): string {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}
