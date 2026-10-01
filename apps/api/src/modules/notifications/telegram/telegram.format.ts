import type { TelegramEvent } from '@nodeservice/shared';

/** Экранирование для parse_mode=HTML: Telegram понимает только &lt; &gt; &amp;. */
export const esc = (s: string): string =>
  s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

export const TELEGRAM_EVENT_ICON: Record<TelegramEvent, string> = {
  incident_crit: '🔴',
  incident_warn: '🟡',
  needs_confirm: '🟠',
  resolved: '✅',
  autofix_started: '🔧',
  fix_failed: '⚠️',
  reminder: '⏰',
  maintenance: '🛠',
  check_failed: '🧪',
  jarvis_card: '🧠',
  login: '🔐',
  billing_soon: '💳',
  billing_overdue: '🔴',
  panel_health: '🖥',
};

export interface TelegramMessageInput {
  event: TelegramEvent;
  title: string;
  body?: string | null;
  server?: { name: string; host?: string | null } | null;
  /** Хвост сообщения курсивом: «инцидент открыт в 17:12 · критичный». */
  footer?: string | null;
}

/** Строка — подпись целиком: кончается двоеточием, не пункт списка и не ссылка. */
export const LABEL_LINE = /^(?!•)(?!.*https?:\/\/)[^\n]{2,120}:$/;

/**
 * Строка вида «Подпись: значение» или «Подпись:» — подпись жирным (витрина `telegram-messages-variants.html`,
 * 1A). Маркеры списка «• …» и обычные предложения не трогаем.
 */
function formatLine(line: string): string {
  // Строка-подпись целиком: «Вход арендодателя (host:1819), из России:» — жирная, хоть внутри и есть двоеточия
  // (адрес с портом, время). Правило «подпись: значение» ниже двоеточий внутри подписи не допускает.
  if (LABEL_LINE.test(line)) return `<b>${esc(line)}</b>`;
  const m = /^([^:•\n]{2,40}):(\s.*)?$/.exec(line);
  if (!m || /https?$/i.test(m[1] ?? '')) return esc(line);
  return `<b>${esc(m[1] ?? '')}:</b>${esc(m[2] ?? '')}`;
}

/**
 * Сообщение блоками (вариант 1A): заголовок — что случилось; вторая строка — сервер и адрес; дальше текст
 * как есть по строкам, с жирными подписями; пустые строки разделяют блоки; хвост курсивом. Имя сервера,
 * если оно уже во второй строке, из заголовка убираем. Длина — в пределах 4096 символов Telegram.
 */
export function formatTelegramMessage(m: TelegramMessageInput): string {
  const name = m.server?.name;
  const title = name && m.title.endsWith(` · ${name}`) ? m.title.slice(0, -` · ${name}`.length) : m.title;
  const parts = [`${TELEGRAM_EVENT_ICON[m.event]} <b>${esc(title)}</b>`];
  if (m.server)
    parts.push(`<b>${esc(m.server.name)}</b>${m.server.host ? ` · <code>${esc(m.server.host)}</code>` : ''}`);
  const body = m.body?.trim();
  if (body) parts.push('', body.split('\n').map(formatLine).join('\n'));
  if (m.footer) parts.push('', `<i>${esc(m.footer)}</i>`);
  const text = parts.join('\n');
  return text.length > 4000 ? `${text.slice(0, 3990)}…` : text;
}

/** Сколько длился сбой — словами: «меньше минуты», «1 мин 30 с», «12 мин», «2 ч 5 мин». */
export function outageDuration(ms: number): string {
  const sec = Math.max(0, Math.floor(ms / 1000));
  if (sec < 60) return 'меньше минуты';
  const min = Math.floor(sec / 60);
  if (min < 10) return sec % 60 ? `${min} мин ${sec % 60} с` : `${min} мин`;
  if (min < 60) return `${min} мин`;
  return min % 60 ? `${Math.floor(min / 60)} ч ${min % 60} мин` : `${Math.floor(min / 60)} ч`;
}

/**
 * Короткий сбой, о котором не успели сообщить: дело закрылось, пока тревога ждала разбора Джарвиса. Вместо
 * пары «тревога → починилось» — одно сообщение: что было, сколько длился, чем закончился. Отсчёт — от
 * момента, когда панель заметила сбой (начаться он мог раньше). «В норме» говорим, только когда сбой
 * действительно прошёл; дело закрыто по другой причине — пересказываем её, ничего не утверждая.
 * Заголовок и текст — для `formatTelegramMessage`.
 */
export function shortOutageMessage(m: {
  /** Как называлось дело: «Сервер недоступен». */
  what: string;
  lastedMs: number;
  recovered: boolean;
  /** Чем закончилось: «помог шаг …» или причина закрытия. */
  how?: string | null;
}): { title: string; body: string } {
  const how = m.how?.trim().replace(/[.…]+$/, '') ?? '';
  const lines = [`Длился с момента обнаружения: ${outageDuration(m.lastedMs)}`];
  if (m.recovered) lines.push(`Сейчас: в норме — ${how || 'проблема исчезла сама'}.`);
  else if (how) lines.push(`Чем закончилось: ${how}.`);
  return {
    title: `${m.recovered ? 'Короткий сбой уже прошёл' : 'Короткий сбой, дело уже закрыто'}: ${m.what}`,
    body: lines.join('\n'),
  };
}

/** Внутри ли момент тихих часов (в часовом поясе панели); окно может переходить через полночь. */
export function inQuietHours(now: Date, from: string, to: string, timeZone: string): boolean {
  let hm: string;
  try {
    hm = new Intl.DateTimeFormat('en-GB', {
      timeZone,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(now);
  } catch {
    return false;
  }
  const cur = hm.replace(/^24/, '00');
  if (from === to) return false;
  return from < to ? cur >= from && cur < to : cur >= from || cur < to;
}

/** «17:12» в поясе владельца. */
export function localTime(now: Date, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat('ru-RU', { timeZone, hour: '2-digit', minute: '2-digit' }).format(now);
  } catch {
    return now.toISOString().slice(11, 16);
  }
}
