import { describe, expect, it } from 'vitest';

import { linkifyServers } from './link-servers';

const S = [
  { id: '11111111-1111-4111-8111-111111111111', name: 'ru-bridge (Аренда VK)' },
  { id: '22222222-2222-4222-8222-222222222222', name: 'nl' },
  { id: '33333333-3333-4333-8333-333333333333', name: 'nl-2' },
];
const link = (name: string, id: string) => `[${name}](server:${id})`;

describe('linkifyServers', () => {
  it('имя с пробелами и скобками становится ссылкой, в том числе внутри жирного', () => {
    const r = linkifyServers('**ru-bridge (Аренда VK)** — 4 инцидента', S);
    expect(r).toBe(`**${link('ru-bridge (Аренда VK)', S[0]?.id ?? '')}** — 4 инцидента`);
  });
  it('длинное имя берётся раньше короткого, а часть слова ссылкой не становится', () => {
    const r = linkifyServers('nl-2 и nl, но не nlx и не anl', S);
    expect(r).toBe(`${link('nl-2', S[2]?.id ?? '')} и ${link('nl', S[1]?.id ?? '')}, но не nlx и не anl`);
  });
  it('код, блоки кода и готовые ссылки не трогаются', () => {
    const src =
      'Команда `ssh nl` и\n```\nssh nl\n```\nи [nl](https://x.example) остаются как есть, а nl — нет';
    const r = linkifyServers(src, S);
    expect(r).toContain('`ssh nl`');
    expect(r).toContain('```\nssh nl\n```');
    expect(r).toContain('[nl](https://x.example)');
    expect(r.endsWith(`а ${link('nl', S[1]?.id ?? '')} — нет`)).toBe(true);
  });
  it('пустой парк и слишком короткие имена — текст без изменений', () => {
    expect(linkifyServers('nl', [])).toBe('nl');
    expect(linkifyServers('a', [{ id: 'x', name: 'a' }])).toBe('a');
  });
  it('регулярные символы в имени экранируются', () => {
    const r = linkifyServers('узел a.b+c работает', [
      { id: '44444444-4444-4444-8444-444444444444', name: 'a.b+c' },
    ]);
    expect(r).toContain('[a.b+c](server:');
    expect(linkifyServers('узел aXb+c', [{ id: 'x', name: 'a.b+c' }])).toBe('узел aXb+c');
  });
});
