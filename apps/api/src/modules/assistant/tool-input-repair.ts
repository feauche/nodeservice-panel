/**
 * Модель иногда пишет часть вызова инструмента разметкой прямо внутри строки параметра:
 * «…посмотрите логи.</explanation> <parameter name="commands">[{…}]». Тогда в «Подсказках» видна каша из
 * тегов, а команды теряются. Разбираем это обратно: текст до разметки остаётся в своём поле, каждый
 * `<parameter name="x">значение` становится полем x (JSON, если разбирается), если модель его не заполнила.
 *
 * Разметкой вызова считаем только её саму: открывающие `<parameter name="…">`, `<invoke …>`,
 * `<function_calls>`; закрытие собственного поля (`</explanation>`), если за ним идёт тег или конец текста; и —
 * в конце текста поля — закрывающие `</parameter>`, `</invoke>`, `</function_calls>`. Любой другой тег — это
 * текст: раньше значение резалось на первом же закрывающем теге, и статья с HTML в блоке кода, `<kbd>` или
 * `<details>` сохранялась обрубком, а инструмент отвечал «Статья сохранена».
 */
const PARAM_RE = /<(?:antml:)?parameter\s+name="([A-Za-z_][\w-]*)"\s*>/;
/** Начало следующего, уже чужого вызова: его параметры к этому вызову не относятся. */
const NEXT_CALL_RE = /<(?:antml:)?(?:invoke\b[^<>]*|function_calls\s*)>/;
const CALL_TAGS = 'parameter|invoke|function_calls';

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Хвост текста из закрывающих тегов разметки вызова; с `key` — ещё и `</имя поля>`: так модель «закрывает»
 * своё поле. Пробелы перед хвостом шаблон не захватывает (их убирает trim): с ними длинная строка из одних
 * пробелов разбиралась бы квадратично долго.
 */
const tailRe = (key?: string): RegExp =>
  new RegExp(`(?:<\\/(?:antml:)?(?:${CALL_TAGS}${key === undefined ? '' : `|${escapeRe(key)}`})>\\s*)+$`);
const TAIL_RE = tailRe();
/**
 * Модель «закрыла» своё поле, и дальше идёт тег или конец текста: остальное — уже не текст поля, даже если
 * следующее поле вписано не `<parameter>`, а собственным тегом. Обычный текст после такого тега не режем.
 */
const ownCloseRe = (key: string): RegExp => new RegExp(`<\\/(?:antml:)?${escapeRe(key)}>\\s*(?=<|$)`);

/**
 * Поля, где модель пишет готовый документ: в теле статьи по праву бывает XML с любыми тегами, в том числе
 * похожими на разметку вызова. В таком поле срезаем только хвост из закрывающих тегов в самом конце, середину
 * не трогаем никогда — лучше редкий обрывок разметки в статье, чем молча потерянная статья.
 */
const VERBATIM_FIELDS = new Map<string, ReadonlySet<string>>([['save_kb_article', new Set(['content'])]]);

const isEmpty = (v: unknown): boolean =>
  v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);

const value = (raw: string): unknown => {
  const t = raw.replace(TAIL_RE, '').trim();
  try {
    return JSON.parse(t);
  } catch {
    return t;
  }
};

/** `tool` — имя инструмента: по нему узнаём поля-документы, в которых середину текста трогать нельзя. */
export function repairToolInput(input: unknown, tool?: string): unknown {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return input;
  const out: Record<string, unknown> = { ...(input as Record<string, unknown>) };
  const verbatim = tool ? VERBATIM_FIELDS.get(tool) : undefined;
  for (const [key, v] of Object.entries(input as Record<string, unknown>)) {
    if (typeof v !== 'string') continue;
    if (verbatim?.has(key)) {
      const body = v.replace(tailRe(key), '');
      if (body !== v) out[key] = body.trimEnd();
      continue;
    }
    // Всё после начала следующего вызова — не этот вызов: ни текст поля, ни его параметры.
    const next = v.search(NEXT_CALL_RE);
    const mine = next < 0 ? v : v.slice(0, next);
    const p = mine.search(PARAM_RE);
    // Текст поля — до закрытия самого поля или первого вписанного параметра, без хвоста из закрывающих
    // тегов разметки.
    const ends = [mine.search(ownCloseRe(key)), p].filter((i) => i >= 0);
    const own = (ends.length > 0 ? mine.slice(0, Math.min(...ends)) : mine).replace(tailRe(key), '');
    if (own === v) continue;
    out[key] = own.trim();
    if (p < 0) continue;
    const parts = mine.slice(p).split(new RegExp(PARAM_RE.source, 'g'));
    // split с группой: ['', name1, value1, name2, value2, …]
    for (let i = 1; i + 1 < parts.length; i += 2) {
      const name = parts[i] as string;
      if (name !== key && isEmpty(out[name])) out[name] = value(parts[i + 1] as string);
    }
  }
  return out;
}
