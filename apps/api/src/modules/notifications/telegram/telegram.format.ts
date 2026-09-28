import type { TelegramEvent } from '@nodeservice/shared';

/** Экранирование для parse_mode=HTML: Telegram понимает только &lt; &gt; &amp;. */
export const esc = (s: string): string =>
  s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

const ICON: Record<TelegramEvent, string> = {
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
};

export interface TelegramMessageInput {
  event: TelegramEvent;
  title: string;
  body?: string | null;
  server?: { name: string; host?: string | null } | null;
  /** Хвост сообщения курсивом: «инцидент открыт в 17:12 · критичный». */
  footer?: string | null;
}

/**
 * Строка вида «Подпись: значение» или «Подпись:» — подпись жирным (витрина `telegram-messages-variants.html`,
 * 1A). Маркеры списка «• …» и обычные предложения не трогаем.
 */
function formatLine(line: string): string {
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
  const parts = [`${ICON[m.event]} <b>${esc(title)}</b>`];
  if (m.server)
    parts.push(`<b>${esc(m.server.name)}</b>${m.server.host ? ` · <code>${esc(m.server.host)}</code>` : ''}`);
  const body = m.body?.trim();
  if (body) parts.push('', body.split('\n').map(formatLine).join('\n'));
  if (m.footer) parts.push('', `<i>${esc(m.footer)}</i>`);
  const text = parts.join('\n');
  return text.length > 4000 ? `${text.slice(0, 3990)}…` : text;
}

/** Внутри ли момент тихих часов (в часовом поясе владельца); окно может переходить через полночь. */
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
