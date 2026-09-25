import type { Server } from '@nodeservice/shared';

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** Символы, из которых состоят имена серверов: рядом с ними имя не считается отдельным словом. */
const NAME_CHAR = '[A-Za-zА-Яа-яЁё0-9_-]';

/**
 * Имена серверов в ответе Джарвиса → ссылки `[имя](server:<id>)`, чтобы по имени открывалась карточка сервера.
 * Код (`…` и блоки ```), готовые ссылки не трогаем; длинные имена берутся первыми, чтобы «nl-2» не съел «nl-20».
 */
export function linkifyServers(content: string, servers: Array<Pick<Server, 'id' | 'name'>>): string {
  const list = [...servers]
    .filter((s) => s.name.trim().length >= 2)
    .sort((a, b) => b.name.length - a.name.length);
  if (list.length === 0) return content;
  const byName = new Map(list.map((s) => [s.name, s.id]));
  const re = new RegExp(`(?<!${NAME_CHAR})(${list.map((s) => esc(s.name)).join('|')})(?!${NAME_CHAR})`, 'g');
  // Обычный текст отделяем от кода и уже готовых ссылок.
  const skip = /```[\s\S]*?```|`[^`\n]*`|\[[^\]\n]*\]\([^)\n]*\)/g;
  let out = '';
  let last = 0;
  for (const m of content.matchAll(skip)) {
    out += content.slice(last, m.index).replace(re, (name) => `[${name}](server:${byName.get(name)})`);
    out += m[0];
    last = (m.index ?? 0) + m[0].length;
  }
  return out + content.slice(last).replace(re, (name) => `[${name}](server:${byName.get(name)})`);
}
