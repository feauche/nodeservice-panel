import { z } from 'zod';

/**
 * Теги серверов (витрина `tags-variants.html`, вариант A и фильтр 1): один вид — строчные, пробел внутри
 * превращается в дефис; опечатку вроде «noed» ловим сравнением с популярными тегами парка.
 */
export const TAG_MAX_LENGTH = 24;

/** «Node Main!» → «node-main». Пустая строка — тега нет. */
export function normalizeTag(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^\p{L}\p{N}_-]/gu, '')
    .slice(0, TAG_MAX_LENGTH);
}

/** Расстояние с перестановкой соседних букв как одной ошибкой: «noed» → «node» = 1. */
export function tagDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const d: number[][] = Array.from({ length: m + 1 }, (_, i) => [i, ...new Array<number>(n).fill(0)]);
  const row0 = d[0] as number[];
  for (let j = 1; j <= n; j += 1) row0[j] = j;
  for (let i = 1; i <= m; i += 1) {
    const cur = d[i] as number[];
    const prev = d[i - 1] as number[];
    for (let j = 1; j <= n; j += 1) {
      cur[j] = Math.min(
        (prev[j] as number) + 1,
        (cur[j - 1] as number) + 1,
        (prev[j - 1] as number) + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1])
        cur[j] = Math.min(cur[j] as number, ((d[i - 2] as number[])[j - 2] as number) + 1);
    }
  }
  return (d[m] as number[])[n] as number;
}

/**
 * Похож ли тег на другой, уже популярный в парке (на 2+ серверах): отличие в 1 букву (у длинных — в 2).
 * Сам тег при этом редкий — не больше чем на одном сервере. Иначе null.
 */
export function similarTag(
  tag: string,
  counts: Readonly<Record<string, number>>,
): { tag: string; count: number } | null {
  if (tag.length < 3 || (counts[tag] ?? 0) > 1) return null;
  let best: { tag: string; count: number; d: number } | null = null;
  for (const [k, count] of Object.entries(counts)) {
    if (k === tag || count < 2) continue;
    const d = tagDistance(tag, k);
    if (d <= (k.length >= 6 ? 2 : 1) && (!best || d < best.d || (d === best.d && count > best.count)))
      best = { tag: k, count, d };
  }
  return best ? { tag: best.tag, count: best.count } : null;
}

/** Сколько серверов с каждым тегом. */
export function tagCounts(servers: ReadonlyArray<{ tags: readonly string[] }>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const s of servers) for (const t of s.tags) out[t] = (out[t] ?? 0) + 1;
  return out;
}

const tagValue = z.string().transform(normalizeTag).pipe(z.string().min(1, 'Пустой тег').max(TAG_MAX_LENGTH));

/** Переименовать тег на всех серверах; если новый уже есть — слить. */
export const tagRenameSchema = z.object({ from: z.string().min(1).max(TAG_MAX_LENGTH), to: tagValue });
export type TagRename = z.infer<typeof tagRenameSchema>;
export const tagDeleteSchema = z.object({ tag: z.string().min(1).max(TAG_MAX_LENGTH) });
export const tagOpResultSchema = z.object({ updated: z.number().int() });
export type TagOpResult = z.infer<typeof tagOpResultSchema>;
