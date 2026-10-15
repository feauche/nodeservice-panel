import {
  isCheckHostReport,
  type NodeTcpDiagnostics,
  type TcpCheckReport,
  type TelegramEvent,
  tcpPortOf,
  tcpRegions,
} from '@nodeservice/shared';

/** Экранирование для parse_mode=HTML: Telegram понимает только &lt; &gt; &amp;. */
export const esc = (s: string): string =>
  s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

export const TELEGRAM_EVENT_ICON: Record<TelegramEvent, string> = {
  incident_crit: '🔴',
  incident_warn: '🟡',
  scenario: '🟡',
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
  /**
   * Проверка портов Check-Host у события: вместо строк со ссылками — онлайн, вывод и порты по странам
   * (в расширенном оформлении — таблица), отчёты — кнопками и ссылками.
   */
  tcp?: NodeTcpDiagnostics | null;
  /** Пояс панели: время проверок в таблице портов («РФ, 16:09») — как в подписи сообщения. */
  timeZone?: string | null;
  /** Таблица портов под текстом (сообщение сценария): вывод уже в строке шага «TCP: …». */
  ports?: TcpCheckReport | null;
  /** «Восстановление» — короткими строками вместо одной фразы (витрина telegram-2026-10, вариант A). */
  recovery?: RecoveryFacts | null;
  /** Свой значок вместо значка события: 🌊 у волны (0.106.0). */
  icon?: string | null;
}

/** Что вернулось после сбоя — для сообщения «Восстановление». */
export interface RecoveryFacts {
  /** Онлайн при обнаружении сбоя, сейчас и до падения; нет падения онлайна — только «сейчас» и обычный. */
  online?: { low: number | null; now: number; before: number | null; usual?: number | null } | null;
  /** Адрес до смены — если адрес ноды меняли. */
  oldAddress?: string | null;
  /** Последняя проверка порта на нынешнем адресе. */
  tcp?: TcpCheckReport | null;
  /** DNS-запись ноды: подпись («DNS-запись nl1.example.ru») и что с ней; ⚠️ — нужна ручная замена. */
  dns?: { label: string; text: string } | null;
}

/** Сколько точек подключилось: «1 из 3»; никто не подключился, а отказали не все (остальные молчат) — прочерк. */
export function tcpCount(rows: Array<{ state: string }>): string {
  const ok = rows.filter((r) => r.state === 'ok').length,
    failed = rows.filter((r) => r.state === 'failed').length;
  return rows.length && (ok || failed === rows.length) ? `${ok} из ${rows.length}` : '—';
}
/** «−100 %» — насколько упал онлайн. */
export const onlineDrop = (o: { before: number; after: number }): string =>
  `−${Math.round(((o.before - o.after) / Math.max(o.before, 1)) * 100)} %`;

/** Вывод проверки портов в сообщении: значок, заголовок и пояснение (витрина telegram-2026-10, вариант C). */
export function tcpVerdict(r: TcpCheckReport): { mark: string; head: string; text: string } {
  switch (r.verdict) {
    case 'reachable':
      return {
        mark: '🟢',
        head: 'Порты доступны',
        text: 'Подключились точки и в России, и в других странах — это не блокировка порта. Причину падения стоит искать на самой ноде.',
      };
    case 'russia_partial':
      return {
        mark: '🟠',
        head: 'Частично недоступен из РФ',
        text: r.confirmed
          ? 'Из России подключилась только часть точек, из других стран — все; повтор через минуту — то же. Похоже на блокировку у части провайдеров.'
          : 'Из России подключилась только часть точек, из других стран — все. Повторной проверки не было — вывод не подтверждён.',
      };
    case 'russia_unreachable':
      return {
        mark: '🔴',
        head: 'Недоступен из РФ',
        text: 'Ни одна точка в России не подключилась, из других стран — все. Вероятная блокировка.',
      };
    case 'port_unreachable':
      return {
        mark: '🔴',
        head: 'Порты не отвечают',
        text: 'Не подключилась ни одна точка — ни в России, ни в других странах: нода выключена, порт закрыт или его фильтруют.',
      };
    default:
      return {
        mark: '⚪',
        head: 'Нет полного результата',
        text: r.error
          ? `Проверка не удалась: ${r.error}`
          : 'Часть точек не ответила вовремя (в таблице — прочерк) — вывода о блокировке пока нет.',
      };
  }
}

type PortReport = Pick<TcpCheckReport, 'target' | 'observations' | 'ports'>;
const portsOf = (r: PortReport) => (r.ports?.length ? r.ports : [r]);
/**
 * Таблица портов (вариант C): столбцы — порты, строки — откуда проверяли. Повтор подтвердил первую проверку —
 * две строки РФ со временем обеих («РФ, 16:09», «РФ, 16:10»): видно, на чём основан вывод.
 */
export function tcpPortTable(
  r: TcpCheckReport,
  timeZone: string | null | undefined,
): { ports: string[]; rows: string[][] } {
  const list = portsOf(r);
  const ports = list.map((p) => tcpPortOf(p.target));
  const russia = (report: PortReport) => {
    const byPort = new Map(portsOf(report).map((p) => [tcpPortOf(p.target), p]));
    return ports.map((port) => {
      const p = byPort.get(port);
      return p ? tcpCount(tcpRegions(p).ru) : '—';
    });
  };
  const other = list.map((p) => tcpCount(tcpRegions(p).other));
  const at = (iso: string) => localTime(new Date(iso), timeZone ?? 'UTC');
  return {
    ports,
    rows: r.first
      ? [
          [`РФ, ${at(r.first.checkedAt)}`, ...russia(r.first)],
          [`РФ, ${at(r.checkedAt)}`, ...russia(r)],
          ['Другие страны', ...other],
        ]
      : [
          ['РФ', ...russia(r)],
          ['Другие страны', ...other],
        ],
  };
}
/** Порты одной строкой обычного сообщения: «РФ 1 из 3, повтор 1 из 3 · другие 3 из 3»; прочерк — «нет ответа». */
function portReach(r: TcpCheckReport, timeZone: string | null | undefined) {
  const { ports, rows } = tcpPortTable(r, timeZone);
  const said = (v: string | undefined) => (v === '—' || v === undefined ? 'нет ответа' : v);
  return ports.map((port, i) => {
    const russia = r.first
      ? `РФ ${said(rows[0]?.[i + 1])}, повтор ${said(rows[1]?.[i + 1])}`
      : `РФ ${said(rows[0]?.[i + 1])}`;
    return { port, russia, other: said(rows.at(-1)?.[i + 1]) };
  });
}
/** Проверка портов обычным сообщением: онлайн, вывод со значком, строка на порт со ссылкой на отчёт. */
function tcpHtml(t: NodeTcpDiagnostics, timeZone: string | null | undefined): string[] {
  const r = t.report;
  const v = tcpVerdict(r);
  const out: string[] = [];
  if (t.online)
    out.push(`<b>Онлайн:</b> ${t.online.before} → ${t.online.after} (${onlineDrop(t.online)})`, '');
  out.push(`<b>${v.mark} ${esc(v.head)}</b>`, esc(v.text), '');
  const links = new Map((r.ports?.length ? r.ports : [r]).map((p) => [tcpPortOf(p.target), p.link]));
  for (const p of portReach(r, timeZone)) {
    const href = links.get(p.port);
    const link = isCheckHostReport(href) ? ` · <a href="${esc(href)}">отчёт</a>` : '';
    out.push(`• <b>Порт <code>${esc(p.port)}</code></b> — ${p.russia} · другие ${p.other}${link}`);
  }
  return out;
}
/** Порты под текстом сценария одной строкой: «5492 — РФ 1 из 3 · 2226 — РФ 2 из 3 · другие страны 3 из 3». */
export function portsLine(r: TcpCheckReport, timeZone: string | null | undefined): string {
  const list = portReach(r, timeZone);
  const sameOther = list.every((p) => p.other === list[0]?.other);
  return sameOther
    ? `${list.map((p) => `${p.port} — ${p.russia}`).join(' · ')} · другие страны ${list[0]?.other ?? 'нет ответа'}`
    : list.map((p) => `${p.port} — ${p.russia}, другие ${p.other}`).join(' · ');
}

/** Часть строки «Восстановления»: текст или адрес моноширинным. */
export type RecoveryPart = string | { code: string };
/** Строки «Восстановления»: подпись и значение — онлайн, смена адреса, порт, DNS-запись. */
export function recoveryLines(f: RecoveryFacts): Array<{ label: string; parts: RecoveryPart[] }> {
  const out: Array<{ label: string; parts: RecoveryPart[] }> = [];
  const o = f.online;
  if (o)
    out.push({
      label: 'Онлайн',
      parts: [
        o.low !== null && o.before !== null
          ? `${o.low} → ${o.now} (до падения ${o.before})`
          : `${o.now}${o.usual ? ` (обычно около ${o.usual})` : ''}`,
      ],
    });
  if (f.oldAddress) out.push({ label: 'Адрес сменили', parts: ['был ', { code: f.oldAddress }] });
  if (f.tcp) {
    const list = portReach(f.tcp, null).map((p) => ({ ...p, text: `${p.russia} · другие ${p.other}` }));
    const same = list.every((p) => p.text === list[0]?.text);
    if (same && list.length)
      out.push({
        label: list.length === 1 ? `Порт ${list[0]?.port}` : `Порты ${list.map((p) => p.port).join(', ')}`,
        parts: [list[0]?.text ?? ''],
      });
    else for (const p of list) out.push({ label: `Порт ${p.port}`, parts: [p.text] });
  }
  if (f.dns) out.push({ label: f.dns.label, parts: [f.dns.text] });
  return out;
}
const recoveryHtml = (f: RecoveryFacts) =>
  recoveryLines(f).map(
    (l) =>
      `<b>${esc(l.label)}:</b> ${l.parts.map((x) => (typeof x === 'string' ? esc(x) : `<code>${esc(x.code)}</code>`)).join('')}`,
  );

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
  const parts = [`${m.icon ?? TELEGRAM_EVENT_ICON[m.event]} <b>${esc(title)}</b>`];
  if (m.server)
    parts.push(`<b>${esc(m.server.name)}</b>${m.server.host ? ` · <code>${esc(m.server.host)}</code>` : ''}`);
  const body = m.body?.trim();
  const recovery = m.recovery ? recoveryHtml(m.recovery) : [];
  if (m.tcp) parts.push('', ...tcpHtml(m.tcp, m.timeZone));
  else if (recovery.length) parts.push('', ...recovery);
  else if (body) parts.push('', body.split('\n').map(formatLine).join('\n'));
  if (m.ports && !m.tcp) parts.push('', `<b>Порты:</b> ${esc(portsLine(m.ports, m.timeZone))}`);
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
