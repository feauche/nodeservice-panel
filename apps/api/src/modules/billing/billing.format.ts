import {
  type BillingCurrency,
  type BillingKind,
  type BillingPeriodUnit,
  billingPeriodLabel,
  formatMoney,
  formatRub,
} from '@nodeservice/shared';

import { zoneLabel } from '../../common/local-time.js';
import { esc } from '../notifications/telegram/telegram.format.js';
import type { RichBlock, RichCell, RichText } from '../notifications/telegram/telegram.rich.js';
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

const richCell = (text: RichText, header = false): RichCell => ({
  text,
  ...(header ? { is_header: true as const } : {}),
  align: 'left',
  valign: 'top',
});
const richBold = (text: string): RichText => ({ type: 'bold', text });

/** Биллинг в sendRichMessage: срок, сумма и привязанные серверы читаются как компактная таблица. */
export function formatBillingRichMessage(m: BillingMessageInput): RichBlock[] {
  const tz = m.timeZone ?? 'Europe/Moscow';
  const due = dueInWords(m.paidUntil, m.now);
  const sum: RichText =
    m.currency !== 'RUB' && m.amountRubMinor !== null
      ? [
          richBold(formatMoney(m.amountMinor, m.currency)),
          ' · ',
          { type: 'italic', text: `≈ ${formatRub(m.amountRubMinor)} по курсу ЦБ` },
        ]
      : richBold(formatMoney(m.amountMinor, m.currency));
  const rows: RichCell[][] = [
    [richCell('Сумма', true), richCell(sum)],
    [richCell('Оплатить до', true), richCell(`${when(m.paidUntil, tz)} (${zoneLabel(m.paidUntil, tz)})`)],
    [richCell('Период', true), richCell(billingPeriodLabel(m.periodUnit, m.periodCount))],
  ];
  if (m.domain) rows.push([richCell('Домен', true), richCell(m.domain)]);
  if (m.servers.length > 0) {
    const label = m.kind === 'cert' ? 'Развёрнут на' : m.servers.length > 1 ? 'Серверы' : 'Сервер';
    rows.push([richCell(label, true), richCell(m.servers.map((s) => s.name).join(', '))]);
  }
  const blocks: RichBlock[] = [
    {
      type: 'heading',
      size: 3,
      text:
        m.state === 'overdue'
          ? `🔴 Оплата просрочена ${due.replace(/^просрочено /, '')}`
          : `💳 Скоро оплата — ${due}`,
    },
    {
      type: 'paragraph',
      text: m.provider ? [richBold(m.provider), ' · ', m.title] : richBold(m.title),
    },
    { type: 'table', cells: rows, is_bordered: true, is_striped: true, is_compact: true },
  ];
  if (m.note)
    blocks.push({
      type: 'paragraph',
      text: [richBold('Заметка: '), { type: 'italic', text: m.note.slice(0, 200) }],
    });
  const down = m.servers.filter((s) => s.down);
  if (m.state === 'overdue' && down.length > 0)
    blocks.push({
      type: 'paragraph',
      text: [
        '⚠️ ',
        richBold(`${down.map((s) => s.name).join(', ')} ${down.length > 1 ? 'недоступны' : 'недоступен'}`),
        ' — вероятно, из-за неоплаты. Продлите у провайдера и отметьте продление в панели.',
      ],
    });
  blocks.push({ type: 'footer', text: 'Биллинг · после оплаты отметьте продление в панели' });
  return blocks;
}
