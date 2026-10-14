/**
 * Предохранитель еженедельной ревизии базы знаний: переписанная моделью статья принимается, только если в ней
 * сохранилось всё, что нельзя терять (блоки кода, команды, адреса, числа, заголовки), и не появилось ничего,
 * чего не было в исходнике (новые адреса, IP, команды). Иначе статья остаётся как была — до следующей недели.
 */

/** Вступление модели вместо статьи: «Вот исправленная статья:», «Конечно! …». */
const INTRO = /^(?:(?:вот|ниже|конечно|here is|here's|sure)(?!\p{L})|исправленн|отредактированн)/iu;
/** Статья целиком завёрнута в ```markdown … ``` — обёртку снимаем, сама статья может быть годной. */
const WRAPPED = /^```(?:markdown|md)?[ \t]*\n([\s\S]*?)\n```$/i;

const norm = (s: string): string => s.toLowerCase().replace(/\s+/g, ' ').trim();

/** Строки блоков кода, команды в `…`, адреса и IP — то, что модель не должна ни терять, ни выдумывать. */
function literals(md: string): string[] {
  const out: string[] = [];
  for (const m of md.matchAll(/```[^\n]*\n([\s\S]*?)```/g))
    for (const line of (m[1] ?? '').split('\n')) if (line.trim()) out.push(line.trim());
  const prose = md.replace(/```[\s\S]*?```/g, ' ');
  for (const m of prose.matchAll(/`([^`\n]+)`/g)) if (m[1]?.trim()) out.push(m[1].trim());
  for (const m of md.matchAll(/https?:\/\/[^\s)>\]"'`]+/g)) out.push(m[0].replace(/[.,;:!?]+$/, ''));
  for (const m of md.matchAll(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g)) out.push(m[0]);
  return out;
}

/** Числа из двух и больше знаков (порты, сроки, версии, время) и тексты заголовков — их терять нельзя. */
function keepers(md: string): string[] {
  const prose = md.replace(/```[\s\S]*?```/g, ' ');
  const out: string[] = [];
  for (const m of prose.matchAll(/(?<![\p{L}\p{N}.])\d[\d.:]*\d(?![\p{L}\p{N}])/gu)) out.push(m[0]);
  for (const m of md.matchAll(/^#{1,6}\s+(.+?)\s*#*$/gm)) {
    const heading = (m[1] ?? '').replace(/[*_`]/g, '').trim();
    if (heading) out.push(heading);
  }
  return out;
}

export type ReviewVerdict = { ok: true; text: string } | { ok: false; why: string };

/** Принять ли переписанную статью вместо исходной. */
export function checkReview(original: string, candidate: string): ReviewVerdict {
  let text = candidate.trim();
  const wrapped = WRAPPED.exec(text);
  if (wrapped) text = (wrapped[1] ?? '').trim();
  if (!text) return { ok: false, why: 'пустой ответ' };
  if (INTRO.test(text)) return { ok: false, why: 'вступление вместо статьи' };
  if (text.length < original.length * 0.5) return { ok: false, why: 'статья стала вдвое короче' };
  if (text.length > original.length * 1.5 + 500) return { ok: false, why: 'статья сильно выросла' };
  const result = norm(text);
  const source = norm(original);
  for (const item of [...literals(original), ...keepers(original)])
    if (!result.includes(norm(item))) return { ok: false, why: `пропало: ${item.slice(0, 60)}` };
  for (const item of literals(text))
    if (!source.includes(norm(item))) return { ok: false, why: `появилось новое: ${item.slice(0, 60)}` };
  return { ok: true, text };
}
