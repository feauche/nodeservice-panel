/** Поиск по прошлым беседам с Джарвисом: слова без регистра и «ё», все слова в одном сообщении. */
export interface PastMessage {
  conversationId: string;
  title: string;
  role: string;
  content: string;
  createdAt: Date;
}

export interface ConversationHit {
  chat: string;
  at: string;
  who: 'администратор' | 'Джарвис';
  snippet: string;
}

const WORDS_MAX = 5;
const RADIUS = 140;

const norm = (s: string): string => s.toLowerCase().replace(/ё/g, 'е');

/** Слова запроса: не короче двух знаков, не больше пяти. */
export function searchWords(query: string): string[] {
  return [
    ...new Set(
      norm(query)
        .split(/[^\p{L}\p{N}_-]+/u)
        .filter((w) => w.length >= 2),
    ),
  ].slice(0, WORDS_MAX);
}

/** Кусок текста вокруг первого найденного слова, без переносов строк. */
export function snippetAround(text: string, words: string[]): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  const low = norm(flat);
  const at = Math.min(...words.map((w) => (low.indexOf(w) >= 0 ? low.indexOf(w) : Number.POSITIVE_INFINITY)));
  if (!Number.isFinite(at)) return flat.slice(0, RADIUS * 2);
  const from = Math.max(0, at - RADIUS);
  const to = Math.min(flat.length, at + RADIUS);
  return `${from > 0 ? '…' : ''}${flat.slice(from, to)}${to < flat.length ? '…' : ''}`;
}

/** Самые свежие сообщения, где встречаются все слова запроса. Строки приходят новыми сверху. */
export function searchPastMessages(rows: PastMessage[], query: string, limit: number): ConversationHit[] {
  const words = searchWords(query);
  if (words.length === 0) return [];
  const out: ConversationHit[] = [];
  for (const r of rows) {
    const low = norm(r.content);
    if (!words.every((w) => low.includes(w))) continue;
    out.push({
      chat: r.title,
      at: r.createdAt.toISOString(),
      who: r.role === 'user' ? 'администратор' : 'Джарвис',
      snippet: snippetAround(r.content, words),
    });
    if (out.length >= limit) break;
  }
  return out;
}
