import type { Me } from '@nodeservice/shared';

const dateFmt = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });
const dateTimeFmt = new Intl.DateTimeFormat('ru-RU', {
  day: 'numeric',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
});

export function formatDate(iso: string): string {
  return dateFmt.format(new Date(iso));
}

export function formatDateTime(iso: string): string {
  return dateTimeFmt.format(new Date(iso));
}

/** «только что», «5 мин назад», «2 ч назад», иначе дата. */
export function formatAgo(iso: string, now = Date.now()): string {
  const diff = Math.max(0, now - new Date(iso).getTime());
  const min = Math.floor(diff / 60_000);
  if (min < 1) return 'только что';
  if (min < 60) return `${min} мин назад`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} ч назад`;
  return formatDateTime(iso);
}

/** Сколько осталось до момента: «через 5 ч 40 мин», «через 12 мин», «через 3 дн», «уже истекла». */
export function formatIn(iso: string, now = Date.now()): string {
  const diff = new Date(iso).getTime() - now;
  if (diff <= 0) return 'уже истекла';
  const min = Math.floor(diff / 60_000);
  if (min < 1) return 'меньше минуты';
  if (min < 60) return `через ${min} мин`;
  const h = Math.floor(min / 60);
  if (h < 24) {
    const m = min % 60;
    return m > 0 ? `через ${h} ч ${m} мин` : `через ${h} ч`;
  }
  const d = Math.floor(h / 24);
  return `через ${d} ${plural(d, ['день', 'дня', 'дней'])}`;
}

/** Русские формы: plural(3, ['сессия', 'сессии', 'сессий']). */
export function plural(n: number, forms: [string, string, string]): string {
  const abs = Math.abs(n) % 100;
  const last = abs % 10;
  if (abs > 10 && abs < 20) return forms[2];
  if (last > 1 && last < 5) return forms[1];
  if (last === 1) return forms[0];
  return forms[2];
}

/** Как вошли в сессии — по amr. */
export function loginMethod(amr: Me['amr'] | undefined): string {
  if (!amr) return '—';
  if (amr.includes('recovery')) return 'пароль + код восстановления';
  if (amr.includes('trusted')) return 'пароль · запомненное устройство';
  if (amr.includes('totp')) return 'пароль + код 2FA';
  return 'пароль';
}
