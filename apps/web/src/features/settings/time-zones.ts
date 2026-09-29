import type { ComboOption } from '@/components/ui/combobox';

/**
 * Пояса с русскими названиями городов: браузер знает только названия областей («Красноярск» для
 * Новосибирска), поэтому частые пояса подписаны вручную. Остальные — «область · UTC+N» из браузера.
 */
const NAMED: ReadonlyArray<readonly [zone: string, name: string, group: string]> = [
  ['Europe/Kaliningrad', 'Калининград', 'Россия'],
  ['Europe/Moscow', 'Москва', 'Россия'],
  ['Europe/Samara', 'Самара', 'Россия'],
  ['Asia/Yekaterinburg', 'Екатеринбург', 'Россия'],
  ['Asia/Omsk', 'Омск', 'Россия'],
  ['Asia/Novosibirsk', 'Новосибирск', 'Россия'],
  ['Asia/Krasnoyarsk', 'Красноярск', 'Россия'],
  ['Asia/Irkutsk', 'Иркутск', 'Россия'],
  ['Asia/Yakutsk', 'Якутск', 'Россия'],
  ['Asia/Vladivostok', 'Владивосток', 'Россия'],
  ['Asia/Magadan', 'Магадан', 'Россия'],
  ['Asia/Kamchatka', 'Петропавловск-Камчатский', 'Россия'],
  ['Europe/Minsk', 'Минск', 'Соседние страны'],
  ['Europe/Kyiv', 'Киев', 'Соседние страны'],
  ['Asia/Almaty', 'Алматы', 'Соседние страны'],
  ['Asia/Tashkent', 'Ташкент', 'Соседние страны'],
  ['Asia/Bishkek', 'Бишкек', 'Соседние страны'],
  ['Asia/Tbilisi', 'Тбилиси', 'Соседние страны'],
  ['Asia/Yerevan', 'Ереван', 'Соседние страны'],
  ['Asia/Baku', 'Баку', 'Соседние страны'],
  ['Europe/Istanbul', 'Стамбул', 'Соседние страны'],
  ['Europe/Berlin', 'Берлин', 'Европа'],
  ['Europe/Amsterdam', 'Амстердам', 'Европа'],
  ['Europe/Helsinki', 'Хельсинки', 'Европа'],
  ['Europe/London', 'Лондон', 'Европа'],
  ['UTC', 'Всемирное время', 'Европа'],
];
const NAME = new Map(NAMED.map(([z, n]) => [z, n]));

/** «UTC+6», «UTC−3», «UTC+5:30» — сейчас (с учётом летнего времени). */
export function utcOffsetLabel(zone: string, at = new Date()): string {
  try {
    const part = new Intl.DateTimeFormat('ru', { timeZone: zone, timeZoneName: 'shortOffset' })
      .formatToParts(at)
      .find((p) => p.type === 'timeZoneName')?.value;
    const off = (part ?? 'GMT').replace('GMT', '').replace(/^[+-]0$/, '');
    return off ? `UTC${off.replace('-', '−')}` : 'UTC';
  } catch {
    return zone;
  }
}

function regionName(zone: string): string {
  try {
    const n = new Intl.DateTimeFormat('ru', { timeZone: zone, timeZoneName: 'longGeneric' })
      .formatToParts(new Date())
      .find((p) => p.type === 'timeZoneName')?.value;
    return n && !n.startsWith('GMT') ? n.replace(/, стандартное время$/, '') : zone;
  } catch {
    return zone;
  }
}

/** Как пояс выглядит в поле: «Омск · UTC+6». */
export function timeZoneLabel(zone: string): string {
  return `${NAME.get(zone) ?? regionName(zone)} · ${utcOffsetLabel(zone)}`;
}

export function browserTimeZone(): string | null {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
  } catch {
    return null;
  }
}

/** Пункты списка: сначала подписанные по-русски, дальше все остальные пояса браузера. */
export function timeZoneOptions(): ComboOption[] {
  const all = typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : [];
  const named = NAMED.map(([zone, name, group]) => ({
    value: zone,
    label: timeZoneLabel(zone),
    keywords: `${name} ${zone}`,
    group,
  }));
  const rest = all
    .filter((z) => !NAME.has(z))
    .map((zone) => ({ value: zone, label: timeZoneLabel(zone), keywords: zone, group: 'Все пояса' }));
  return [...named, ...rest];
}
