/** Кнопки тулбара редактора статьи: чистые преобразования текста по выделению. */

export type FormatAction =
  | 'h2'
  | 'h3'
  | 'bold'
  | 'italic'
  | 'ul'
  | 'ol'
  | 'quote'
  | 'code'
  | 'table'
  | 'link'
  | 'hr';

export interface FormatResult {
  value: string;
  selStart: number;
  selEnd: number;
}

const LINE_PREFIX = { h2: '## ', h3: '### ', ul: '- ', quote: '> ' } as const;
const LINE_PLACEHOLDER = {
  h2: 'Заголовок',
  h3: 'Заголовок',
  ul: 'Пункт',
  ol: 'Пункт',
  quote: 'Цитата',
} as const;
const ANY_LINE_PREFIX = /^(#{1,6}[ \t]+|[-*+][ \t]+|\d+\.[ \t]+|>[ \t]?)/;
const TABLE = '| Колонка 1 | Колонка 2 |\n| --- | --- |\n| Значение | Значение |';

function wrap(value: string, start: number, end: number, mark: string): FormatResult {
  const sel = value.slice(start, end);
  // Только курсив: «**текст**» — это жирный, а не курсив, поэтому сорванные звёздочки не считаем разметкой.
  const isMark = (s: string) =>
    s.length >= mark.length * 2 &&
    s.startsWith(mark) &&
    s.endsWith(mark) &&
    !(mark === '*' && s.startsWith('**'));
  if (isMark(sel)) {
    const inner = sel.slice(mark.length, sel.length - mark.length);
    return {
      value: value.slice(0, start) + inner + value.slice(end),
      selStart: start,
      selEnd: start + inner.length,
    };
  }
  const outside =
    start >= mark.length &&
    value.slice(start - mark.length, start) === mark &&
    value.slice(end, end + mark.length) === mark &&
    !(mark === '*' && (value[start - 2] === '*' || value[end + 1] === '*'));
  if (outside) {
    return {
      value: value.slice(0, start - mark.length) + sel + value.slice(end + mark.length),
      selStart: start - mark.length,
      selEnd: end - mark.length,
    };
  }
  const text = sel || 'Текст';
  const next = value.slice(0, start) + mark + text + mark + value.slice(end);
  return { value: next, selStart: start + mark.length, selEnd: start + mark.length + text.length };
}

function linePrefix(
  value: string,
  start: number,
  end: number,
  action: 'h2' | 'h3' | 'ul' | 'ol' | 'quote',
): FormatResult {
  const lineStart = start === 0 ? 0 : value.lastIndexOf('\n', start - 1) + 1;
  const effEnd = end > start && value[end - 1] === '\n' ? end - 1 : end;
  const nl = value.indexOf('\n', effEnd);
  const lineEnd = nl === -1 ? value.length : nl;
  const block = value.slice(lineStart, lineEnd);
  const lines = block.split('\n');
  const filled = lines.filter((l) => l.trim() !== '');

  if (filled.length === 0) {
    const text = (action === 'ol' ? '1. ' : LINE_PREFIX[action]) + LINE_PLACEHOLDER[action];
    const prefixLen = text.length - LINE_PLACEHOLDER[action].length;
    return {
      value: value.slice(0, lineStart) + text + value.slice(lineEnd),
      selStart: lineStart + prefixLen,
      selEnd: lineStart + text.length,
    };
  }

  const has = (l: string) => (action === 'ol' ? /^\d+\.[ \t]/.test(l) : l.startsWith(LINE_PREFIX[action]));
  const remove = filled.every(has);
  let n = 0;
  const out = lines.map((l) => {
    if (l.trim() === '') return l;
    const bare = l.replace(ANY_LINE_PREFIX, '');
    if (remove) return bare;
    n += 1;
    return (action === 'ol' ? `${n}. ` : LINE_PREFIX[action]) + bare;
  });
  const newBlock = out.join('\n');
  const next = value.slice(0, lineStart) + newBlock + value.slice(lineEnd);
  if (start === end) {
    const caret = Math.max(lineStart, start + (newBlock.length - block.length));
    return { value: next, selStart: caret, selEnd: caret };
  }
  return { value: next, selStart: lineStart, selEnd: lineStart + newBlock.length };
}

/** Вставка блока отдельным абзацем: пустая строка до и после, чтобы разметка не «слиплась» с соседним текстом. */
function insertBlock(value: string, start: number, end: number, block: string) {
  const before = value.slice(0, start);
  const after = value.slice(end);
  const lead = before === '' || before.endsWith('\n\n') ? '' : before.endsWith('\n') ? '\n' : '\n\n';
  const tail = after.startsWith('\n\n') ? '' : after.startsWith('\n') ? '\n' : after === '' ? '\n' : '\n\n';
  return { value: before + lead + block + tail + after, blockStart: before.length + lead.length };
}

export function applyFormat(action: FormatAction, value: string, start: number, end: number): FormatResult {
  switch (action) {
    case 'bold':
      return wrap(value, start, end, '**');
    case 'italic':
      return wrap(value, start, end, '*');
    case 'h2':
    case 'h3':
    case 'ul':
    case 'ol':
    case 'quote':
      return linePrefix(value, start, end, action);
    case 'code': {
      const sel = value.slice(start, end);
      if (sel !== '' && !sel.includes('\n')) return wrap(value, start, end, '`');
      const text = sel || 'Команда';
      const r = insertBlock(value, start, end, `\`\`\`\n${text}\n\`\`\``);
      return { value: r.value, selStart: r.blockStart + 4, selEnd: r.blockStart + 4 + text.length };
    }
    case 'table': {
      const r = insertBlock(value, start, end, TABLE);
      const from = r.blockStart + TABLE.indexOf('Колонка 1');
      return { value: r.value, selStart: from, selEnd: from + 'Колонка 1'.length };
    }
    case 'hr': {
      const r = insertBlock(value, start, end, '---');
      const at = r.blockStart + 3;
      return { value: r.value, selStart: at, selEnd: at };
    }
    case 'link': {
      const sel = value.slice(start, end);
      const isUrl = /^https?:\/\/\S+$/.test(sel);
      const label = isUrl ? 'Ссылка' : sel || 'Текст';
      const url = isUrl ? sel : 'https://';
      const md = `[${label}](${url})`;
      const next = value.slice(0, start) + md + value.slice(end);
      // Выделяем то, что пользователю дописывать: адрес для текста, текст — для готового адреса.
      return isUrl
        ? { value: next, selStart: start + 1, selEnd: start + 1 + label.length }
        : { value: next, selStart: start + label.length + 3, selEnd: start + md.length - 1 };
    }
  }
}
