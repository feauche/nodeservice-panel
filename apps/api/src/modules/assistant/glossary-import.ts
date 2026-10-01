export interface GlossaryTerm {
  term: string;
  explain: string;
}

const TERM_MAX_CHARS = 60;
const TERM_MAX_WORDS = 7;
/** Короче — это чаще заголовок с двоеточием («Панель: что с чем связано»), а не определение. */
const EXPLAIN_MIN = 20;
const EXPLAIN_MAX = 500;
/**
 * Объяснение — русский текст: русских букв не меньше половины. В словаре владельца самое «латинское» объяснение
 * («MTProto: прокси-протокол Telegram…») русское на 69 %, а в выводе lscpu, docker inspect и docker info русских
 * букв нет вовсе.
 */
const EXPLAIN_MIN_CYRILLIC = 0.5;
/** Как минимум столько строк «термин: объяснение», чтобы текст мог быть словарём. */
const PURE_MIN_TERMS = 8;
/** Словарь, а не настройки: пояснения в среднем длиннее этого. */
const PURE_AVG_EXPLAIN = 25;
/** Доля текста, занятая строками-определениями, начиная с которой текст считается только словарём. */
const PURE_SHARE = 0.6;
/** Строка-заголовок длиннее — это вступление («Здесь собраны все термины…»), а не заголовок словаря. */
const TITLE_MAX = 80;
/** Заголовок словаря ищем в первых строках: над ним бывают просьба («Добавь в пояснения:») и меню сайта. */
const TITLE_LINES = 3;

/** Подписи вида «Шаг 1: …», «Важно: …» — это не термины. */
const NOT_TERM =
  /^(шаг|этап|пункт|step|важно|внимание|примечание|note|warning|совет|пример|example)(?![\p{L}\p{N}])/iu;
const SEPARATOR = /:\s|\s[—–]\s|\s-\s/;
/**
 * Значение из вывода команды, лога или настроек, а не объяснение: хэш (образ, id контейнера), путь из двух и
 * более частей (/var/lib/docker), дата ISO и перечисление через «;» («Mitigation; PTI» у lscpu).
 */
const MACHINE_VALUE =
  /(?<![\p{L}\p{N}])[0-9a-f]{12,}(?![\p{L}\p{N}])|(?:^|[\s("'«=])~?\.{0,2}\/[\w.@-]+\/|\d{4}-\d{2}-\d{2}|;/iu;
/**
 * Объяснение начинается с совета («переключите…», «проверьте…», «не выключайте…»): это пункт «проблема:
 * решение», а не определение. В словаре владельца так не начинается ни одно из 68 объяснений, в частых
 * проблемах клиентов — все.
 */
const ADVICE = /^[«"'(]?(?:не\s+)?\p{Script=Cyrillic}+(?:ите|йте|ьте)(?![\p{L}\p{N}])/iu;
/**
 * Заголовок словаря начинается со слова-пометки: «Термины простыми словами», «## Глоссарий», «Словарь VPN»,
 * «Основные понятия». Слово в середине строки пометкой не считается: «Главная · Гайды · Термины» — это меню
 * сайта, «Частые проблемы и термины» — обычный заголовок, «Понятия не имею…» — вовсе не заголовок.
 */
const GLOSSARY_TITLE =
  /^[^\p{L}\p{N}]*(?:\d+[.)]\s*)?(?:(?:основные|ключевые|базовые)\s+(?:понятия|термин(?!ал))|(?:краткий\s+|список\s+)?(?:глоссари|словар|термин(?!ал)))/iu;
/** Просьба над словарём: «Добавь в пояснения:», «Добавьте эти термины». «Пояснения» — глоссарий панели. */
const GLOSSARY_ASK =
  /^(?:добав|внес|занес|запиш)\p{L}*(?:\s+\p{L}+){0,2}?\s+(?:глоссари|словар|термин(?!ал)|пояснени)/iu;
/** Шапка таблицы-словаря: «| Термин | Простыми словами |». Таблица «Симптом | Что делать» словарём не считается. */
const GLOSSARY_COLUMN = /термин(?!ал)|понятие|сокращени|аббревиатур/i;

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
  // Латинский ключ в прямых кавычках — это JSON или YAML («"Id"» у docker inspect); русский термин в кавычках — нет.
  if (/^["'][\w.$@-]+["']$/.test(term)) return false;
  return !NOT_TERM.test(term);
}

/**
 * Объяснение — русский текст, а не значение из вывода команды и не совет «сделайте…». Отдельного запрета на
 * латинские ключи вроде ResolvConfPath нет: вывод команд отсекается по объяснению, а «sendThrough: настройка,
 * указывающая…» из словаря владельца — настоящее определение.
 */
function isExplanation(explain: string): boolean {
  if (MACHINE_VALUE.test(explain) || ADVICE.test(explain)) return false;
  const letters = explain.match(/\p{L}/gu)?.length ?? 0;
  const cyrillic = explain.match(/\p{Script=Cyrillic}/gu)?.length ?? 0;
  return letters > 0 && cyrillic >= letters * EXPLAIN_MIN_CYRILLIC;
}

/**
 * Строка, похожая на определение: термин и объяснение не короче EXPLAIN_MIN (короче — заголовок с двоеточием).
 * Русский ли это текст, здесь не проверяется: так видны и строки, которые сервер в «Пояснения» не взял.
 */
function splitTermLine(raw: string): GlossaryTerm | null {
  let line = raw.trim();
  if (!line || line.startsWith('#') || line.startsWith('>')) return null;
  if (line.startsWith('|')) {
    const cells = line
      .split('|')
      .map((c) => clean(c))
      .filter(Boolean);
    const [term, explain] = cells;
    if (!term || !explain || /^:?-+:?$/.test(term) || term === 'Термин') return null;
    return isTerm(term) && explain.length >= EXPLAIN_MIN ? { term, explain } : null;
  }
  line = clean(line.replace(/^(?:[-*•▪◦]|\d+[.)])\s+/, ''));
  const m = SEPARATOR.exec(line);
  if (!m) return null;
  const term = line.slice(0, m.index).trim();
  const explain = line.slice(m.index + m[0].length).trim();
  return isTerm(term) && explain.length >= EXPLAIN_MIN ? { term, explain } : null;
}

/** Одна строка → термин с объяснением или null. Понимает «термин: …», «термин — …», списки и строки таблицы. */
export function parseTermLine(raw: string): GlossaryTerm | null {
  const t = splitTermLine(raw);
  return t && isExplanation(t.explain) ? { term: t.term, explain: t.explain.slice(0, EXPLAIN_MAX) } : null;
}

/** Safari и Word при копировании дают не только \n: возврат каретки, разделитель строк U+2028 и абзацев U+2029. */
const BREAKS =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: вертикальная табуляция и разрыв страницы тоже приходят при копировании
  /\r\n?|[\u2028\u2029\u000b\u000c\u0085]/g;
const normalizeBreaks = (text: string): string => text.replace(BREAKS, '\n');

/** Строки текста без блоков кода: внутри ``` лежат команды и их вывод, а не определения. */
function withoutCode(text: string): string[] {
  const out: string[] = [];
  let code = false;
  for (const line of text.split('\n')) {
    if (line.trim().startsWith('```')) code = !code;
    else if (!code) out.push(line);
  }
  return out;
}

/** Все строки-определения из текста, без повторов внутри самого текста. */
export function parseGlossaryText(raw: string): GlossaryTerm[] {
  const seen = new Set<string>();
  const out: GlossaryTerm[] = [];
  for (const line of withoutCode(normalizeBreaks(raw))) {
    const t = parseTermLine(line);
    if (!t || seen.has(t.term.toLowerCase())) continue;
    seen.add(t.term.toLowerCase());
    out.push(t);
  }
  return out;
}

/** Уровень заголовка: «#»…«######» — 1…6, строка целиком жирным («**Термины**») — 7; не заголовок — null. */
function headingLevel(line: string): number | null {
  const t = line.trim();
  const md = /^(#{1,6})\s/.exec(t);
  if (md) return md[1]?.length ?? null;
  return /^\*\*[^*]+\*\*:?$|^__[^_]+__:?$/.test(t) ? 7 : null;
}

/** Строка-заголовок скопированной страницы: короткая, без конца предложения, не «термин: объяснение». */
function isTitle(line: string): boolean {
  const t = clean(line);
  return t.length > 0 && t.length <= TITLE_MAX && !/[.!?](?:\s|$)/.test(t) && !parseTermLine(line);
}

const isTableRow = (line: string): boolean => line.trim().startsWith('|');

/**
 * Строки словаря, который автор сам пометил, и есть ли вне его строки, похожие на определения. Пометка —
 * заголовок, который начинается со слова «Термины», «Глоссарий», «Словарь», «Основные понятия», или просьба
 * «Добавь в пояснения:» в первых строках текста до всяких определений (тогда словарь — весь текст ниже); такой
 * же заголовок Markdown или строка жирным (раздел до следующего заголовка того же уровня или выше); таблица с
 * колонкой «Термин». Без пометки строки «ключ: значение» — это вывод команды, настройки или список «проблема:
 * решение», и что с ними делать, решает модель.
 */
function glossaryLines(text: string): { lines: string[]; outside: boolean } {
  const all = withoutCode(text);
  const lines: string[] = [];
  let outside = false;
  // Уровень заголовка, открывшего раздел словаря; 0 — заголовок всей страницы, его ничто не закрывает.
  let open: number | null = null;
  let table = false;
  // Сколько непустых строк позади и было ли среди них определение: заголовок страницы стоит выше определений.
  let seen = 0;
  let defined = false;
  for (const [i, line] of all.entries()) {
    const top = seen < TITLE_LINES && !defined;
    if (line.trim()) seen += 1;
    const level = headingLevel(line);
    if (level !== null) {
      if (open !== null && level <= open) open = null;
      if (open === null && GLOSSARY_TITLE.test(clean(line.replace(/^\s*#+/, '')))) open = level;
      continue;
    }
    if (
      open === null &&
      top &&
      isTitle(line) &&
      (GLOSSARY_TITLE.test(clean(line)) || GLOSSARY_ASK.test(clean(line)))
    ) {
      open = 0;
      continue;
    }
    const def = splitTermLine(line) !== null;
    defined ||= def;
    // Таблица-словарь — от шапки с колонкой «Термин» до конца таблицы.
    if (!isTableRow(line)) table = false;
    else if (!isTableRow(all[i - 1] ?? '')) table = GLOSSARY_COLUMN.test(line);
    if (open !== null || table) lines.push(line);
    else if (def) outside = true;
  }
  return { lines, outside };
}

/** Строки-определения, если их хватает на словарь: не меньше восьми, объяснения содержательные, не «порт: 443». */
function definitionsIn(lines: string[]): GlossaryTerm[] | null {
  const terms = parseGlossaryText(lines.join('\n'));
  if (terms.length < PURE_MIN_TERMS) return null;
  const avg = terms.reduce((n, t) => n + t.explain.length, 0) / terms.length;
  return avg >= PURE_AVG_EXPLAIN ? terms : null;
}

/** Строки-определения занимают почти весь текст, а блоков кода нет: для такого текста статья не нужна. */
function mostlyDefinitions(text: string, lines: string[]): boolean {
  if (text.includes('```')) return false;
  const total = text.replace(/\s+/g, '').length;
  const inTerms = lines.filter((l) => parseTermLine(l)).reduce((n, l) => n + l.replace(/\s+/g, '').length, 0);
  return total > 0 && inTerms / total >= PURE_SHARE;
}

/**
 * Помеченный словарь: его термины, термины строк раздела, которые похожи на определение, но проверку не прошли
 * (rejected), и словарь ли это целиком (pure). Целиком — только когда сервер взял всё похожее на определения:
 * иначе ответ «все новые термины добавлены» был бы неправдой. Если отброшенных строк не меньше, чем терминов,
 * пометке верить нельзя (под «Термины» оказались вывод команды или частые проблемы клиентов) — тогда null.
 */
function markedGlossary(raw: string): { terms: GlossaryTerm[]; rejected: string[]; pure: boolean } | null {
  const text = normalizeBreaks(raw);
  const { lines, outside } = glossaryLines(text);
  const terms = definitionsIn(lines);
  if (!terms) return null;
  const rejected = lines.flatMap((l) => {
    const t = splitTermLine(l);
    return t && !parseTermLine(l) ? [t.term] : [];
  });
  if (rejected.length >= terms.length) return null;
  return { terms, rejected, pure: rejected.length === 0 && !outside && mostlyDefinitions(text, lines) };
}

/**
 * Строки-определения из помеченного словаря, если их достаточно. Годится и для целого словаря, и для раздела
 * «Термины» внутри статьи.
 */
export function extractDefinitions(raw: string): GlossaryTerm[] | null {
  return markedGlossary(raw)?.terms ?? null;
}

/**
 * Текст целиком — словарь терминов: помеченный словарь с содержательными объяснениями, из которого сервер взял
 * все строки-определения, и почти ничего кроме него. Для такого текста статья не нужна, всё уходит в глоссарий.
 * Блоки кода и список коротких «ключ: значение» под это не подходят.
 */
export function isPureGlossary(raw: string): boolean {
  return markedGlossary(raw)?.pure ?? false;
}

/** Вопросительное слово в начале предложения: «Почему процессор слабый?», «Что с этим делать?», «Нормально ли это?». */
const QUESTION =
  /(?:^|[.!?…]\s+)(?:(?:почему|зачем|отчего|что|чем|как|какой|какая|какое|какие|каким|где|куда|откуда|когда|сколько|кто|чей|разве|неужели)(?![\p{L}\p{N}])|\p{L}+\s+ли(?![\p{L}\p{N}]))[^.!?\n]*\?/iu;

/**
 * Подпись страницы с вопросом к читателю — «Остались вопросы?», «Не нашли термин?», «Нужна помощь?»: сайты
 * ставят её в конце статьи отдельной строкой или перед приглашением написать. Это не вопрос Джарвису.
 */
const PAGE_PROMPT =
  /^[^\p{L}\p{N}]*(?:(?:остались|есть(?:\s+ещё)?)\s+вопросы|не\s+нашли(?:\s+\p{L}+){0,4}|нужна\s+помощь)\s*\?/iu;

/**
 * В сообщении есть вопрос к Джарвису: вопрос в первой строке, строка кончается знаком вопроса или предложение
 * начинается с вопросительного слова. Тогда нужен ответ модели, а не шаблон про термины. Подпись страницы
 * («Остались вопросы?», «Не нашли термин? Напишите в чат…») вопросом не считается.
 */
export function asksQuestion(raw: string): boolean {
  const lines = withoutCode(normalizeBreaks(raw))
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines[0]?.includes('?')) return true;
  return lines.some((l) => {
    const rest = l.replace(PAGE_PROMPT, '').trim();
    return /\?[)»"'*_]*$/.test(rest) || QUESTION.test(rest);
  });
}

/**
 * Что сервер делает с присланным сообщением сам, не полагаясь на модель: термины помеченного словаря дописывает
 * в «Пояснения», а если всё сообщение — словарь и сервер взял из него всё (pure), отвечает без модели. Строки
 * раздела, которые сервер не взял (rejected), модель получает поимённо. Вопрос, вывод команды, список
 * «проблема: решение» и строки без пометки словаря разбирает модель — тогда null.
 */
export function autoGlossary(
  raw: string,
): { terms: GlossaryTerm[]; rejected: string[]; pure: boolean } | null {
  return asksQuestion(raw) ? null : markedGlossary(raw);
}

/**
 * Статья, которая по сути и есть словарь: такую создавать нельзя, термины живут только в «Пояснения». Пометка
 * здесь не нужна: модель может переписать словарь списком и назвать статью «Основы VPN». А пункты
 * «проблема: решение» определениями не считаются, поэтому статья с частыми проблемами клиентов сохраняется.
 */
export function isGlossaryArticle(title: string, content: string): boolean {
  const n = parseGlossaryText(content).length;
  if (/глоссари|словарь/i.test(title) && n >= 4) return true;
  const text = normalizeBreaks(content);
  const lines = text.split('\n');
  return definitionsIn(lines) !== null && mostlyDefinitions(text, lines);
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
