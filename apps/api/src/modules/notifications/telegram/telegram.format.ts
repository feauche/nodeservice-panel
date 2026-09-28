import type { TelegramEvent } from '@nodeservice/shared';

/** Экранирование для parse_mode=HTML: Telegram понимает только &lt; &gt; &amp;. */
export const esc = (s: string): string =>
  s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

const ICON: Record<TelegramEvent, string> = {
  incident_crit: '🔴',
  incident_warn: '🟡',
  needs_confirm: '🟠',
  resolved: '✅',
  maintenance: '🛠',
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
 * Подробное сообщение (витрина, вариант M2): иконка и заголовок жирным, пустая строка, текст по
 * предложениям, сервер с адресом, курсивный хвост. Длина — в пределах 4096 символов Telegram.
 */
export function formatTelegramMessage(m: TelegramMessageInput): string {
  const parts = [`${ICON[m.event]} <b>${esc(m.title)}</b>`];
  if (m.body?.trim()) parts.push('', esc(m.body.trim()));
  if (m.server)
    parts.push(
      '',
      `Сервер: <b>${esc(m.server.name)}</b>${m.server.host ? ` <code>${esc(m.server.host)}</code>` : ''}`,
    );
  if (m.footer) parts.push(`<i>${esc(m.footer)}</i>`);
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
