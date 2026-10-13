import { type Scenario, scenarioConditions, scenarioLabels } from '@nodeservice/shared';

/** Строчная первая буква в середине фразы — только у русского слова: «TCP недоступен» и «Host» не трогаем. */
export const lower = (s: string) => (/^[А-ЯЁ][а-яё]/.test(s) ? s.charAt(0).toLowerCase() + s.slice(1) : s);
/** «на 1 выбранной ноде», «на 21 выбранной ноде», «на 3 выбранных нодах». */
export const pickedWord = (n: number) =>
  n % 10 === 1 && n % 100 !== 11 ? 'выбранной ноде' : 'выбранных нодах';
/** «А», «А и Б», «А, Б и В». */
export const listWords = (words: string[]) =>
  words.length < 2 ? (words[0] ?? '') : `${words.slice(0, -1).join(', ')} и ${words.at(-1)}`;

/** Условия фразой: «нода потеряла связь и TCP недоступен». */
export const conditionsPhrase = (rule: Pick<Scenario, 'conditions' | 'trigger' | 'conditionMode'>) =>
  scenarioConditions(rule as Scenario)
    .map((c) => lower(scenarioLabels[c]))
    .join(rule.conditionMode === 'all' ? ' и ' : ' или ');

/**
 * На каких нодах — для фразы «… на ___»: «любой ноде», до трёх нод по именам («ноде «Турция - 1»»), иначе
 * числом («5 выбранных нодах»). Ноды не выбраны — null.
 */
export function scopePhrase(
  rule: Pick<Scenario, 'scope' | 'nodes'>,
  nodes: ReadonlyArray<{ uuid: string; name: string }>,
): string | null {
  if (rule.scope === 'all') return 'любой ноде';
  const count = rule.nodes.length;
  if (!count) return null;
  const picked = nodes.filter((n) => rule.nodes.includes(n.uuid));
  return picked.length === count && count <= 3
    ? `${count === 1 ? 'ноде' : 'нодах'} ${listWords(picked.map((n) => `«${n.name}»`))}`
    : `${count} ${pickedWord(count)}`;
}
