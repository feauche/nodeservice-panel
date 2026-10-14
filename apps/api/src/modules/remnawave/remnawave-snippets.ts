/**
 * Сниппеты Remnawave — общие куски Xray-конфига, на которые ссылаются профили нод. В `config` профиля ссылка —
 * объект `{"snippet": "имя"}` внутри `outbounds`, `routing.rules` или `routing.balancers`; с Remnawave 3.2.3 ещё и
 * корневой список `"snippets": ["A", "B"]`. Remnawave раскрывает их, собирая конфиг для ноды (replaceSnippetsInArray):
 * массив сниппета встаёт на место ссылки, объект заменяет её, ссылка на неизвестное имя молча пропадает.
 * Панель повторяет это только для чтения — чтобы карта маршрутов и Ассистент видели настоящий конфиг ноды —
 * и помечает вставленное полем `_fromSnippet`, а пропавшие ссылки возвращает отдельно.
 */

export interface RemnawaveSnippet {
  name: string;
  /** Содержимое: массив объектов Xray (или один объект). */
  snippet: unknown;
}

/** Где в конфиге профиля Remnawave раскрывает ссылки на сниппеты. */
const ARRAY_PATHS: Array<[string, ...string[]]> = [
  ['outbounds'],
  ['routing', 'rules'],
  ['routing', 'balancers'],
];
/** Корневые сниппеты не трогают эти ключи (как в Remnawave). */
const ROOT_PROTECTED = new Set(['api', 'inbounds', 'metrics', 'snippets', 'stats']);

export const FROM_SNIPPET = '_fromSnippet';

const isRecord = (v: unknown): v is Record<string, unknown> =>
  Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const clone = <T>(v: T): T => structuredClone(v);

/** Ответ GET /api/snippets → список сниппетов; посторонние строки пропускаются. */
export function parseSnippets(body: Record<string, unknown>): RemnawaveSnippet[] {
  const response = isRecord(body.response) ? body.response : {};
  const list = Array.isArray(response.snippets) ? response.snippets : [];
  return list
    .filter(isRecord)
    .flatMap((row) =>
      typeof row.name === 'string' && row.name ? [{ name: row.name, snippet: row.snippet }] : [],
    );
}

/** Объект, вставленный из сниппета, — с пометкой, откуда он. Не объект — как есть. */
function marked(item: unknown, name: string): unknown {
  return isRecord(item) ? { ...clone(item), [FROM_SNIPPET]: name } : clone(item);
}

export interface SnippetExpansion {
  config: unknown;
  /** Какие сниппеты подставлены, по порядку первого использования. */
  used: string[];
  /** Ссылки на имена, которых нет в Remnawave: при сборке конфига она их молча выбрасывает. */
  missing: Array<{ name: string; where: string }>;
}

/** Раскрыть ссылки на сниппеты в конфиге профиля так же, как Remnawave собирает конфиг для ноды. */
export function expandSnippets(config: unknown, snippets: RemnawaveSnippet[]): SnippetExpansion {
  const byName = new Map(snippets.map((s) => [s.name, s.snippet]));
  const used: string[] = [];
  const missing: SnippetExpansion['missing'] = [];
  const use = (name: string) => {
    if (!used.includes(name)) used.push(name);
  };
  if (!isRecord(config)) return { config, used, missing };
  const out = clone(config);

  for (const path of ARRAY_PATHS) {
    let parent: unknown = out;
    for (const key of path.slice(0, -1)) parent = isRecord(parent) ? parent[key] : undefined;
    const last = path[path.length - 1] as string;
    const array = isRecord(parent) ? parent[last] : undefined;
    if (!Array.isArray(array)) continue;
    // С конца, как Remnawave: вставка не сдвигает ещё не просмотренные ссылки.
    for (let i = array.length - 1; i >= 0; i -= 1) {
      const item = array[i];
      if (!isRecord(item) || typeof item.snippet !== 'string') continue;
      const name = item.snippet;
      if (!byName.has(name)) {
        missing.push({ name, where: path.join('.') });
        array.splice(i, 1);
        continue;
      }
      use(name);
      const content = byName.get(name);
      if (Array.isArray(content)) array.splice(i, 1, ...content.map((c) => marked(c, name)));
      else array[i] = marked(content, name);
    }
  }

  // Корневые сниппеты (Remnawave 3.2.3+): ключи их объектов дописываются в корень, если там такого ключа ещё нет.
  if (Array.isArray(out.snippets)) {
    const added: Record<string, string[]> = {};
    for (const name of out.snippets) {
      if (typeof name !== 'string') continue;
      if (!byName.has(name)) {
        missing.push({ name, where: 'snippets' });
        continue;
      }
      use(name);
      const content = byName.get(name);
      const parts = Array.isArray(content) ? content.filter(isRecord) : isRecord(content) ? [content] : [];
      const merged: Record<string, unknown> = Object.assign({}, ...parts);
      for (const [key, value] of Object.entries(merged)) {
        if (ROOT_PROTECTED.has(key) || key in out) continue;
        out[key] = clone(value);
        added[name] = [...(added[name] ?? []), key];
      }
    }
    delete out.snippets;
    if (Object.keys(added).length) out._rootSnippets = added;
  }
  return { config: out, used, missing };
}

/** Какие сниппеты использует конфиг (без раскрытия): для каталога «где используется». */
export function snippetRefs(config: unknown): string[] {
  const names = new Set<string>();
  if (!isRecord(config)) return [];
  for (const path of ARRAY_PATHS) {
    let node: unknown = config;
    for (const key of path) node = isRecord(node) ? node[key] : undefined;
    if (Array.isArray(node))
      for (const item of node)
        if (isRecord(item) && typeof item.snippet === 'string') names.add(item.snippet);
  }
  if (Array.isArray(config.snippets))
    for (const name of config.snippets) if (typeof name === 'string') names.add(name);
  return [...names];
}
