export interface GlossaryTerm {
  term: string;
  explain: string;
}

const TERM_MAX_CHARS = 60;
const TERM_MAX_WORDS = 7;
/** Короче — это чаще заголовок с двоеточием («Панель: что с чем связано»), а не определение. */
const EXPLAIN_MIN = 20;
const EXPLAIN_MAX = 500;
/** Как минимум столько строк «термин: объяснение», чтобы текст мог быть словарём. */
const PURE_MIN_TERMS = 8;
/** Словарь, а не настройки: пояснения в среднем длиннее этого. */
const PURE_AVG_EXPLAIN = 25;
/** Доля текста, занятая строками-определениями, начиная с которой текст считается только словарём. */
const PURE_SHARE = 0.6;

/** Подписи вида «Шаг 1: …», «Важно: …» — это не термины. */
const NOT_TERM =
  /^(шаг|этап|пункт|step|важно|внимание|примечание|note|warning|совет|пример|example)(?![\p{L}\p{N}])/iu;
const SEPARATOR = /:\s|\s[—–]\s|\s-\s/;

const clean = (s: string): string =>
  s
    .replace(/\*\*|__|`/g, '')
    .replace(/\s+/g, ' ')
    .trim();

function isTerm(term: string): boolean {
  if (term.length < 1 || term.length > TERM_MAX_CHARS) return false;
  if (term.split(' ').length > TERM_MAX_WORDS) return false;
  if (!/\p{L}/u.test(term)) return false;
  if (!/^[\p{L}\p{N}«"'(]/u.test(term)) return false;
  if (/[.!?]\s|[.!?]$|:\/\//.test(term)) return false;
  // Метки времени, скобки и «ключ=значение» — это лог или конфиг, а не термин.
  if (/\d{2}:\d{2}|\d{4}-\d{2}-\d{2}|[[\]{}<>=\\]/.test(term)) return false;
  return !NOT_TERM.test(term);
}

/** Одна строка → термин с объяснением или null. Понимает «термин: …», «термин — …», списки и строки таблицы. */
export function parseTermLine(raw: string): GlossaryTerm | null {
  let line = raw.trim();
  if (!line || line.startsWith('#') || line.startsWith('>')) return null;
  if (line.startsWith('|')) {
    const cells = line
      .split('|')
      .map((c) => clean(c))
      .filter(Boolean);
    const [term, explain] = cells;
    if (!term || !explain || /^:?-+:?$/.test(term) || term === 'Термин') return null;
    return isTerm(term) && explain.length >= EXPLAIN_MIN
      ? { term, explain: explain.slice(0, EXPLAIN_MAX) }
      : null;
  }
  line = clean(line.replace(/^(?:[-*•▪◦]|\d+[.)])\s+/, ''));
  const m = SEPARATOR.exec(line);
  if (!m) return null;
  const term = line.slice(0, m.index).trim();
  const explain = line.slice(m.index + m[0].length).trim();
  if (!isTerm(term) || explain.length < EXPLAIN_MIN) return null;
  return { term, explain: explain.slice(0, EXPLAIN_MAX) };
}

/** Safari и Word при копировании дают не только \n: возврат каретки, разделитель строк U+2028 и абзацев U+2029. */
const BREAKS =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: вертикальная табуляция и разрыв страницы тоже приходят при копировании
  /\r\n?|[\u2028\u2029\u000b\u000c\u0085]/g;
const normalizeBreaks = (text: string): string => text.replace(BREAKS, '\n');

/** Все строки-определения из текста, без повторов внутри самого текста. */
export function parseGlossaryText(raw: string): GlossaryTerm[] {
  const text = normalizeBreaks(raw);
  const seen = new Set<string>();
  const out: GlossaryTerm[] = [];
  for (const line of text.split('\n')) {
    const t = parseTermLine(line);
    if (!t || seen.has(t.term.toLowerCase())) continue;
    seen.add(t.term.toLowerCase());
    out.push(t);
  }
  return out;
}

/**
 * Строки-определения текста, если их достаточно, чтобы считать их словарём: не меньше восьми, объяснения
 * содержательные (а не «порт: 443»). Годится и для целого словаря, и для раздела «Термины» внутри статьи.
 */
export function extractDefinitions(raw: string): GlossaryTerm[] | null {
  const terms = parseGlossaryText(raw);
  if (terms.length < PURE_MIN_TERMS) return null;
  const avg = terms.reduce((n, t) => n + t.explain.length, 0) / terms.length;
  return avg >= PURE_AVG_EXPLAIN ? terms : null;
}

/**
 * Текст целиком — словарь терминов: много строк-определений с содержательными объяснениями и почти
 * ничего кроме них. Для такого текста статья не нужна, всё уходит в глоссарий. Блоки кода и список
 * коротких «ключ: значение» под это не подходят.
 */
export function isPureGlossary(raw: string): boolean {
  const text = normalizeBreaks(raw);
  if (text.includes('```')) return false;
  if (!extractDefinitions(text)) return false;
  const total = text.replace(/\s+/g, '').length;
  const inTerms = text
    .split('\n')
    .filter((l) => parseTermLine(l))
    .reduce((n, l) => n + l.replace(/\s+/g, '').length, 0);
  return total > 0 && inTerms / total >= PURE_SHARE;
}

/** Статья, которая по сути и есть словарь: такую создавать нельзя, термины живут только в «Пояснения». */
export function isGlossaryArticle(title: string, content: string): boolean {
  const n = parseGlossaryText(content).length;
  if (/глоссари|словарь/i.test(title) && n >= 4) return true;
  return isPureGlossary(content);
}

/** Ответ Джарвиса после разбора словаря без участия модели. */
export function glossaryImportReply(found: number, added: number, skipped: string[] = []): string {
  const shown = skipped.slice(0, 15).join(', ') + (skipped.length > 15 ? '…' : '');
  return [
    'Это набор терминов, поэтому отдельную статью я не создавал: для статьи здесь недостаточно содержания. Все новые термины добавлены в общий глоссарий «Пояснения».',
    '',
    `- Найдено терминов: ${found}`,
    `- Добавлено новых: ${added}`,
    `- Уже были в глоссарии: ${skipped.length}${skipped.length > 0 ? ` (${shown})` : ''}`,
    '',
    skipped.length > 0
      ? 'Повторы не добавлялись, прежние пояснения у них не менялись. Если какое-то пояснение нужно поправить, напишите какое.'
      : 'Пояснения сохранены так, как они написаны в вашем тексте.',
  ].join('\n');
}
