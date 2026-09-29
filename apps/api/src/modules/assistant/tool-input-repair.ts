/**
 * Модель иногда пишет часть вызова инструмента разметкой прямо внутри строки параметра:
 * «…посмотрите логи.</explanation> <parameter name="commands">[{…}]». Тогда в «Подсказках» видна каша из
 * тегов, а команды теряются. Разбираем это обратно: текст до первого тега остаётся в своём поле, каждый
 * `<parameter name="x">значение` становится полем x (JSON, если разбирается), если модель его не заполнила.
 */
const PARAM_RE = /<(?:antml:)?parameter\s+name="([A-Za-z_][\w-]*)"\s*>/;
const CLOSE_RE = /<\/(?:antml:)?[A-Za-z_][\w-]*>/;
const TAIL_RE = /\s*(?:<\/(?:antml:)?(?:parameter|invoke|function_calls)>\s*)+$/;

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

export function repairToolInput(input: unknown): unknown {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return input;
  const out: Record<string, unknown> = { ...(input as Record<string, unknown>) };
  for (const [key, v] of Object.entries(input as Record<string, unknown>)) {
    if (typeof v !== 'string') continue;
    const p = v.search(PARAM_RE);
    const c = v.search(CLOSE_RE);
    const cut = [p, c].filter((i) => i >= 0).sort((a, b) => a - b)[0];
    if (cut === undefined) continue;
    out[key] = v.slice(0, cut).trim();
    if (p < 0) continue;
    const rest = v.slice(p);
    const parts = rest.split(new RegExp(PARAM_RE.source, 'g'));
    // split с группой: ['', name1, value1, name2, value2, …]
    for (let i = 1; i + 1 < parts.length; i += 2) {
      const name = parts[i] as string;
      if (name !== key && isEmpty(out[name])) out[name] = value(parts[i + 1] as string);
    }
  }
  return out;
}
