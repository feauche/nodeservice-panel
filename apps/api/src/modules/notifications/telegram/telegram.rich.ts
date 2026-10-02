import type { TelegramMessageInput } from './telegram.format.js';
import { LABEL_LINE, TELEGRAM_EVENT_ICON } from './telegram.format.js';

/**
 * Расширенное оформление сообщений Telegram (Bot API 10.1+, метод sendRichMessage): заголовки и настоящие
 * таблицы вместо строк с точками. Сообщение собирается блоками (поле `blocks`): у блоков строгая схема,
 * текст не нужно экранировать, а ошибка в разметке не превращается в «сообщение не отправлено».
 * Такие сообщения показывают только свежие приложения Telegram — поэтому оформление включается отдельной
 * настройкой, а при отказе Telegram панель тут же шлёт то же сообщение по-старому (см. TelegramService.send).
 */
export type RichText = string | RichText[] | { type: 'bold' | 'italic' | 'code'; text: RichText };

export interface RichCell {
  text: RichText;
  is_header?: true;
  align: 'left' | 'center' | 'right';
  valign: 'top' | 'middle' | 'bottom';
}

export type RichBlock =
  | { type: 'heading'; size: 1 | 2 | 3 | 4 | 5 | 6; text: RichText }
  | { type: 'paragraph'; text: RichText }
  | { type: 'footer'; text: RichText }
  | { type: 'list'; items: Array<{ blocks: RichBlock[] }> }
  | { type: 'table'; cells: RichCell[][]; is_bordered?: true; is_striped?: true; is_compact?: true };

/** Пределы Telegram: 500 блоков и 32 768 знаков; держимся с запасом, остаток честно помечаем. */
const BLOCKS_MAX = 120;
const TEXT_MAX = 12_000;
/** Telegram отвергает пустой paragraph, поэтому визуальный разрыв — неразрывный пробел. */
const SPACER_TEXT = '\u00a0';

const spacer = (): RichBlock => ({ type: 'paragraph', text: SPACER_TEXT });
const isSpacer = (b: RichBlock | undefined): boolean => b?.type === 'paragraph' && b.text === SPACER_TEXT;

const bold = (text: string): RichText => ({ type: 'bold', text });
const cell = (text: RichText, header = false): RichCell => ({
  text,
  ...(header ? { is_header: true as const } : {}),
  align: 'left',
  valign: 'top',
});

const BULLET = /^•\s*/;
/** «Подпись: значение» или «Подпись:» — то же правило, что у обычного оформления (formatLine). */
const LABEL = /^([^:•\n]{2,40}):(\s.*)?$/;

/** Строка текста: подпись до двоеточия — жирным, остальное как есть. */
function lineText(line: string): RichText {
  if (LABEL_LINE.test(line)) return bold(line);
  const m = LABEL.exec(line);
  if (!m || /https?$/i.test(m[1] ?? '')) return line;
  const rest = m[2] ?? '';
  return rest ? [bold(`${m[1]}:`), rest] : bold(`${m[1]}:`);
}

/**
 * Строки с точками подряд: «• Кто — что увидел» у всех — таблица «Откуда / Результат» (так приходят проверки
 * порта с серверов парка); иначе — обычный список.
 */
function bulletsBlock(lines: string[]): RichBlock {
  const rows = lines.map((l) => l.replace(BULLET, '').trim());
  const pairs = rows.map((r) => {
    const at = r.indexOf(' — ');
    return at > 0 ? ([r.slice(0, at).trim(), r.slice(at + 3).trim()] as const) : null;
  });
  if (pairs.every((p): p is readonly [string, string] => p !== null && p[0] !== '' && p[1] !== ''))
    return {
      type: 'table',
      is_bordered: true,
      is_striped: true,
      is_compact: true,
      cells: [
        [cell('Откуда', true), cell('Результат', true)],
        ...pairs.map(([from, saw]) => [cell(from), cell(saw)]),
      ],
    };
  return { type: 'list', items: rows.map((r) => ({ blocks: [{ type: 'paragraph', text: r || '—' }] })) };
}

/**
 * Текст инцидента → блоки. Пустая строка разделяет абзацы; подряд идущие строки с точками становятся таблицей
 * или списком; остальные строки — абзацы с жирными подписями. Пустых блоков не бывает: Telegram их отвергает.
 */
export function bodyBlocks(body: string): RichBlock[] {
  const out: RichBlock[] = [];
  let bullets: string[] = [];
  let separated = false;
  const push = (block: RichBlock) => {
    if (separated && out.length > 0 && !isSpacer(out.at(-1))) out.push(spacer());
    separated = false;
    out.push(block);
  };
  const flush = () => {
    if (bullets.length > 0) push(bulletsBlock(bullets));
    bullets = [];
  };
  for (const raw of body.split('\n')) {
    const line = raw.trim();
    if (!line) {
      flush();
      if (out.length > 0) separated = true;
      continue;
    }
    if (BULLET.test(line)) {
      bullets.push(line);
      continue;
    }
    flush();
    push({ type: 'paragraph', text: lineText(line) });
  }
  flush();
  return out;
}

/**
 * То же сообщение, что formatTelegramMessage, но блоками: заголовок — что случилось; сервер и адрес; текст дела
 * с таблицами проверок; хвост («Критичный инцидент · 17:12») мелкой строкой.
 */
export function richMessageBlocks(m: TelegramMessageInput): RichBlock[] {
  const name = m.server?.name;
  const title = name && m.title.endsWith(` · ${name}`) ? m.title.slice(0, -` · ${name}`.length) : m.title;
  const blocks: RichBlock[] = [
    { type: 'heading', size: 3, text: `${TELEGRAM_EVENT_ICON[m.event]} ${title}` },
  ];
  if (m.server)
    blocks.push({
      type: 'paragraph',
      text: m.server.host
        ? [bold(m.server.name), ' · ', { type: 'code', text: m.server.host }]
        : bold(m.server.name),
    });
  const body = m.body?.trim();
  if (body) {
    if (m.server) blocks.push(spacer());
    const clipped = body.length > TEXT_MAX ? `${body.slice(0, TEXT_MAX)}…` : body;
    const parsed = bodyBlocks(clipped);
    blocks.push(...parsed.slice(0, BLOCKS_MAX));
    if (parsed.length > BLOCKS_MAX) blocks.push({ type: 'paragraph', text: '…остальное — в панели.' });
  }
  if (m.footer) {
    if (body && !isSpacer(blocks.at(-1))) blocks.push(spacer());
    blocks.push({ type: 'footer', text: m.footer });
  }
  return blocks;
}

/** Утренняя сводка после тихих часов: таблица «Когда / Что было». */
export function digestBlocks(rows: Array<{ time: string; title: string }>, more: number): RichBlock[] {
  return [
    { type: 'heading', size: 3, text: '🌅 Пока были тихие часы' },
    {
      type: 'table',
      is_bordered: true,
      is_striped: true,
      is_compact: true,
      cells: [
        [cell('Когда', true), cell('Что было', true)],
        ...rows.map((r) => [cell(r.time), cell(r.title)]),
      ],
    },
    ...(more > 0 ? [{ type: 'paragraph' as const, text: `…и ещё ${more}` }] : []),
    { type: 'footer', text: 'Подробности — в «Инцидентах» панели.' },
  ];
}

/** Резервная копия: отдельная rich-карточка, а сам архив приходит следующим сообщением ответом на неё. */
export function backupBlocks(input: {
  when: string;
  zone: string;
  size: string;
  contents: string;
  encrypted: boolean;
  fileNote?: string | null;
}): RichBlock[] {
  return [
    { type: 'heading', size: 3, text: '🗄 Резервная копия NodeService' },
    {
      type: 'table',
      is_bordered: true,
      is_striped: true,
      is_compact: true,
      cells: [
        [cell('Создана', true), cell(`${input.when} (${input.zone})`)],
        [cell('Размер', true), cell(input.size)],
        [cell('Внутри', true), cell(input.contents)],
        [cell('Защита', true), cell(input.encrypted ? 'Паролем' : 'Без пароля')],
      ],
    },
    ...(!input.encrypted ? [{ type: 'paragraph' as const, text: '⚠ Архив не защищён паролем.' }] : []),
    ...(input.fileNote ? [{ type: 'paragraph' as const, text: input.fileNote }] : []),
    { type: 'footer', text: 'Восстановить: Настройки → Резервные копии → Восстановить из файла.' },
  ];
}

/**
 * Образец для кнопки «Проверить»: по нему владелец видит, показывает ли его Telegram расширенное оформление.
 * Видны заголовок и таблица — можно включать; вместо сообщения «не поддерживается» — приложение нужно обновить.
 */
export function sampleBlocks(chatTitle: string | null): RichBlock[] {
  return [
    { type: 'heading', size: 3, text: '✅ NodeService' },
    {
      type: 'paragraph',
      text: 'Тестовое сообщение в расширенном оформлении. Если вы видите заголовок и таблицу ниже — это приложение Telegram показывает такие сообщения.',
    },
    {
      type: 'table',
      is_bordered: true,
      is_striped: true,
      is_compact: true,
      cells: [
        [cell('Откуда', true), cell('Результат', true)],
        [cell('Россия - 1'), cell('порт отвечает')],
        [cell('Германия - 1'), cell('порт отвечает')],
      ],
    },
    { type: 'footer', text: chatTitle ? `Образец · ${chatTitle}` : 'Образец' },
  ];
}

/** Длина всего текста в блоках — чтобы не упереться в предел Telegram. */
export function richTextLength(blocks: RichBlock[]): number {
  const len = (t: RichText): number =>
    typeof t === 'string'
      ? t.length
      : Array.isArray(t)
        ? t.reduce((n: number, x) => n + len(x), 0)
        : len(t.text);
  let total = 0;
  for (const b of blocks) {
    if (b.type === 'table') for (const row of b.cells) for (const c of row) total += len(c.text);
    else if (b.type === 'list') for (const it of b.items) total += richTextLength(it.blocks);
    else total += len(b.text);
  }
  return total;
}

/**
 * Отказ Telegram относится к самому оформлению (старый сервер, не принятая разметка), а не к чату или сети —
 * значит, то же сообщение стоит послать по-старому. Сеть, таймаут, лимит частоты и «чат не найден» сюда не
 * входят: при них и обычное сообщение не дойдёт, а после таймаута ещё и неизвестно, не дошло ли это.
 */
export function isRichRejected(status: number, description: string): boolean {
  const d = description.toLowerCase();
  if (status === 404) return true;
  if (status !== 400) return false;
  return /rich|inputrichblock|richblock|method not found|can't parse|can't find field|alignment|unsupported/.test(
    d,
  );
}
