import {
  type BillingCurrency,
  type BillingKind,
  type BillingPeriodUnit,
  billingPeriodLabel,
  formatMoney,
  formatRub,
} from '@nodeservice/shared';

import { esc } from '../notifications/telegram/telegram.format.js';
import { dueInWords } from './billing.logic.js';

export interface BillingMessageInput {
  state: 'soon' | 'overdue';
  kind: BillingKind;
  title: string;
  provider: string | null;
  domain: string | null;
  amountMinor: number;
  currency: BillingCurrency;
  /** Рубли по сегодняшнему курсу для $ и €. */
  amountRubMinor: number | null;
  periodUnit: BillingPeriodUnit;
  periodCount: number;
  paidUntil: Date;
  servers: Array<{ name: string; down: boolean }>;
  note: string | null;
  now: Date;
  timeZone?: string;
}

/** Подпись часового пояса: «МСК» для Москвы, иначе «UTC+6» — чтобы время в Telegram не читалось как местное. */
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

const when = (at: Date, timeZone: string) =>
  new Intl.DateTimeFormat('ru-RU', {
    timeZone,
    day: 'numeric',
    month: 'long',
    hour: '2-digit',
    minute: '2-digit',
  })
    .format(at)
    .replace(' в ', ', ');

/**
 * Сообщение биллинга в Telegram: крупно — что и сколько, дальше срок, период, где развёрнуто.
 * Если сервер из этой оплаты сейчас недоступен — отдельный блок: вероятно, дело в неоплате.
 */
export function formatBillingMessage(m: BillingMessageInput): string {
  const tz = m.timeZone ?? 'Europe/Moscow';
  const due = dueInWords(m.paidUntil, m.now);
  const head =
    m.state === 'overdue'
      ? `🔴 <b>Оплата просрочена ${esc(due.replace(/^просрочено /, ''))}</b>`
      : `💳 <b>Скоро оплата — ${esc(due)}</b>`;
  const who = m.provider ? `<b>${esc(m.provider)}</b> · ${esc(m.title)}` : `<b>${esc(m.title)}</b>`;
  const money = `💰 <b>${esc(formatMoney(m.amountMinor, m.currency))}</b>${
    m.currency !== 'RUB' && m.amountRubMinor !== null
      ? `  <i>≈ ${esc(formatRub(m.amountRubMinor))} по курсу ЦБ</i>`
      : ''
  }`;
  const lines = [
    head,
    who,
    '',
    money,
    `📅 до <b>${esc(when(m.paidUntil, tz))}</b> ${esc(`(${zoneLabel(m.paidUntil, tz)})`)} · ${esc(billingPeriodLabel(m.periodUnit, m.periodCount))}`,
  ];
  if (m.domain) lines.push(`🌐 ${esc(m.domain)}`);
  if (m.servers.length > 0) {
    const label = m.kind === 'cert' ? 'Развёрнут на' : m.servers.length > 1 ? 'Серверы' : 'Сервер';
    lines.push(`🖥 ${label}: ${m.servers.map((s) => esc(s.name)).join(', ')}`);
  }
  if (m.note) lines.push(`📝 <i>${esc(m.note.slice(0, 200))}</i>`);
  const down = m.servers.filter((s) => s.down);
  if (m.state === 'overdue' && down.length > 0)
    lines.push(
      '',
      `⚠️ <b>${esc(down.map((s) => s.name).join(', '))} ${down.length > 1 ? 'недоступны' : 'недоступен'}</b> — вероятно, из-за неоплаты. Продлите у провайдера и отметьте продление в панели.`,
    );
  lines.push('', '<i>Биллинг · после оплаты отметьте продление в панели</i>');
  return lines.join('\n');
}
