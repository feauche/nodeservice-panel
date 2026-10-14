/**
 * История беседы для модели: свежие сообщения в пределах бюджета знаков (≈ 15–20 тыс. токенов). Раньше уходила вся
 * беседа каждый раунд — длинная беседа дорожала с каждым вопросом и вытесняла данные инструментов.
 */
export const HISTORY_CHAR_BUDGET = 60_000;
export const HISTORY_MAX_MESSAGES = 40;

/**
 * Свежая часть беседы для модели: с конца, пока помещается в бюджет знаков и число сообщений. Текущий вопрос — последний
 * в списке — входит всегда. Первым отправляется сообщение владельца: модель не начинает беседу со своего ответа.
 */
export function recentHistory<T extends { role: string; content: string }>(
  rows: T[],
  budget = HISTORY_CHAR_BUDGET,
  maxMessages = HISTORY_MAX_MESSAGES,
): { items: T[]; omitted: number } {
  let used = 0;
  let start = rows.length;
  while (start > 0) {
    const next = rows[start - 1] as T;
    const isCurrent = start === rows.length;
    if (!isCurrent && (rows.length - start >= maxMessages || used + next.content.length > budget)) break;
    used += next.content.length;
    start -= 1;
  }
  while (start < rows.length - 1 && rows[start]?.role !== 'user') start += 1;
  return { items: rows.slice(start), omitted: start };
}
