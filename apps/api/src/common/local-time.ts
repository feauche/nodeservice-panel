import { PANEL_TIME_ZONE_DEFAULT } from '@nodeservice/shared';

/**
 * Время для текстов, которые панель пишет сама (дело инцидента, данные для разбора Джарвиса): всегда в
 * одном поясе — поясе панели. Раньше в одном разборе встречались UTC, Москва и пояс сервера панели, и
 * «оплачено до 10:00» у Джарвиса расходилось с «16:00» в «Биллинге».
 */

/** Пояс, который Intl точно поймёт: пустой или неизвестный заменяется поясом по умолчанию. */
export function safeTimeZone(timeZone: string | null | undefined): string {
  if (!timeZone) return PANEL_TIME_ZONE_DEFAULT;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return timeZone;
  } catch {
    return PANEL_TIME_ZONE_DEFAULT;
  }
}

/** Подпись часового пояса: «МСК» для Москвы, иначе «UTC+6» — чтобы время не читалось как местное. */
export function zoneLabel(at: Date, timeZone: string): string {
  if (timeZone === 'Europe/Moscow') return 'МСК';
  try {
    const part = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'shortOffset' })
      .formatToParts(at)
      .find((p) => p.type === 'timeZoneName')?.value;
    return part ? part.replace('GMT', 'UTC').replace(/^UTC$/, 'UTC+0') : timeZone;
  } catch {
    return timeZone;
  }
}

function parts(at: Date, timeZone: string): Record<string, string> {
  return Object.fromEntries(
    new Intl.DateTimeFormat('ru-RU', {
      timeZone: safeTimeZone(timeZone),
      day: 'numeric',
      month: 'long',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(at)
      .map((p) => [p.type, p.value]),
  );
}

/** «16:00» в поясе панели. */
export function localClock(at: Date, timeZone: string): string {
  const p = parts(at, timeZone);
  return `${p.hour}:${p.minute}`;
}

/** «30 сентября 2026» в поясе панели — всегда с годом: по дате судят, не устарели ли сведения. */
export function localDay(at: Date, timeZone: string): string {
  const p = parts(at, timeZone);
  return `${p.day} ${p.month} ${p.year}`;
}

/**
 * «30 сентября, 16:00» в поясе панели. Год называется, только если он не текущий, — или всегда, если
 * попросить (`year`); секунды — по просьбе (`seconds`).
 */
export function localDateTime(
  at: Date,
  timeZone: string,
  now = new Date(),
  opts: { year?: boolean; seconds?: boolean } = {},
): string {
  const p = parts(at, timeZone);
  const year = opts.year || p.year !== parts(now, timeZone).year ? ` ${p.year}` : '';
  return `${p.day} ${p.month}${year}, ${p.hour}:${p.minute}${opts.seconds ? `:${p.second}` : ''}`;
}

/**
 * Отметка времени ISO с поясом: «2026-09-30T09:56:03.000Z», «…T12:56+03:00». Даты без времени сюда не
 * входят. Слева — не часть слова или числа; но в JSON перевод строки записан как «\n», и перед отметкой в
 * начале строки журнала стоит буква n (после табуляции — t) — такие отметки тоже берём.
 */
const ISO_STAMP_RE =
  /(?:(?<=\\[nrt])|(?<![\w.:-]))(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})(?::(\d{2})(?:[.,]\d{1,9})?)?(Z|[+-]\d{2}:?\d{2})(?![\w:])/g;

/**
 * Все отметки времени ISO в тексте — временем в поясе панели: «30 сентября, 15:56:03» (с секундами, если
 * они были в отметке: иначе события одной минуты неразличимы). Данные для модели приходят с отметками в
 * UTC, и она переписывала их в ответ как есть — на часы мимо того, что видит администратор. Кавычек и
 * обратных косых черт замена не добавляет: строка JSON остаётся строкой JSON.
 */
export function localizeIsoTimes(text: string, timeZone: string, now = new Date()): string {
  return text.replace(
    ISO_STAMP_RE,
    (raw, date: string, hm: string, sec: string | undefined, zone: string) => {
      const offset = zone === 'Z' ? 'Z' : `${zone.slice(0, 3)}:${zone.slice(-2)}`;
      const at = new Date(`${date}T${hm}:${sec ?? '00'}${offset}`);
      return Number.isNaN(at.getTime())
        ? raw
        : localDateTime(at, timeZone, now, { seconds: sec !== undefined });
    },
  );
}
