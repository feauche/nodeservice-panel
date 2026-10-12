const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** Символы, из которых состоят имена нод: рядом с ними имя не считается отдельным словом. */
const NAME_CHAR = '[A-Za-zА-Яа-яЁё0-9_-]';

/**
 * Имена нод в ответе Ассистента → ссылки `[имя](node:<uuid>)`, чтобы по имени открывалось окно ноды.
 * Код (`…` и блоки ```), готовые ссылки (в том числе старые `server:` на удалённые серверы) не трогаем;
 * длинные имена берутся первыми, чтобы «nl-2» не съел «nl-20». Одинаковые имена у разных нод не угадываем:
 * они остаются текстом, а точные ссылки дают цитаты с UUID.
 */
export function linkifyNodes(content: string, nodes: Array<{ uuid: string; name: string }>): string {
  const list = nodes
    .filter((node) => node.name.trim().length >= 2)
    .filter((node) => nodes.filter((other) => other.name === node.name).length === 1)
    .sort((a, b) => b.name.length - a.name.length);
  if (list.length === 0) return content;
  const byName = new Map(list.map((node) => [node.name, node.uuid]));
  const re = new RegExp(
    `(?<!${NAME_CHAR})(${list.map((node) => esc(node.name)).join('|')})(?!${NAME_CHAR})`,
    'g',
  );
  const link = (name: string) => `[${name}](node:${byName.get(name)})`;
  // Обычный текст отделяем от кода и уже готовых ссылок.
  const skip = /```[\s\S]*?```|`[^`\n]*`|\[[^\]\n]*\]\([^)\n]*\)/g;
  let out = '';
  let last = 0;
  for (const m of content.matchAll(skip)) {
    out += content.slice(last, m.index).replace(re, link);
    out += m[0];
    last = (m.index ?? 0) + m[0].length;
  }
  return out + content.slice(last).replace(re, link);
}
