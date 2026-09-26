export interface GlossaryEntry {
  term: string;
  explain: string;
}

export interface IncomingTerm extends GlossaryEntry {
  /** Термин уже есть, а его пояснение неверно или явно хуже: заменить его. Иначе повтор пропускается. */
  update?: boolean;
}

const norm = (s: string): string => s.toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ').trim();

/**
 * По каким названиям термин считается тем же самым: основное название и то, что в скобках через запятую
 * («Рукопожатие (handshake)» совпадёт с «handshake», «Fingerprint (отпечаток, fp)» — с «fp»).
 */
export function termKeys(term: string): string[] {
  const keys = new Set<string>();
  const m = /^(.*?)\s*\(([^)]*)\)\s*$/.exec(term.trim());
  const main = norm(m ? (m[1] ?? '') : term);
  if (main) keys.add(main);
  if (m)
    for (const alias of (m[2] ?? '').split(/[,;]/)) {
      const a = norm(alias);
      if (a.length >= 2) keys.add(a);
    }
  return [...keys];
}

export interface MergeResult {
  entries: GlossaryEntry[];
  added: string[];
  /** Терминов, которые уже были: не дублируются. */
  skipped: string[];
  updated: string[];
}

/** Дополнить глоссарий: повторы не добавляются, у существующего можно только поправить пояснение. */
export function mergeTerms(existing: GlossaryEntry[], incoming: IncomingTerm[]): MergeResult {
  const entries = existing.map((e) => ({ ...e }));
  const index = new Map<string, GlossaryEntry>();
  const register = (e: GlossaryEntry) => {
    for (const k of termKeys(e.term)) if (!index.has(k)) index.set(k, e);
  };
  for (const e of entries) register(e);

  const added: string[] = [];
  const skipped: string[] = [];
  const updated: string[] = [];
  for (const t of incoming) {
    const term = t.term.trim().replace(/\s*\|\s*/g, '/');
    const explain = t.explain
      .trim()
      .replace(/\s*\|\s*/g, '/')
      .replace(/\s+/g, ' ');
    if (!term || !explain) continue;
    const found = termKeys(term)
      .map((k) => index.get(k))
      .find((e): e is GlossaryEntry => Boolean(e));
    if (!found) {
      const entry = { term, explain };
      entries.push(entry);
      register(entry);
      added.push(term);
    } else if (t.update && norm(found.explain) !== norm(explain)) {
      found.explain = explain;
      updated.push(found.term);
    } else if (!skipped.includes(found.term)) skipped.push(found.term);
  }
  entries.sort((a, b) => a.term.localeCompare(b.term, 'ru'));
  return { entries, added, skipped, updated };
}
