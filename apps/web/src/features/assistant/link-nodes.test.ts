import { describe, expect, it } from 'vitest';

import { linkifyNodes } from './link-nodes';

const N = [
  { uuid: '11111111-1111-4111-8111-111111111111', name: 'ru-bridge (Аренда VK)' },
  { uuid: '22222222-2222-4222-8222-222222222222', name: 'nl' },
  { uuid: '33333333-3333-4333-8333-333333333333', name: 'nl-2' },
];
const link = (name: string, uuid: string) => `[${name}](node:${uuid})`;

describe('linkifyNodes', () => {
  it('имя с пробелами и скобками становится ссылкой, в том числе внутри жирного', () => {
    const r = linkifyNodes('**ru-bridge (Аренда VK)** — 4 события', N);
    expect(r).toBe(`**${link('ru-bridge (Аренда VK)', N[0]?.uuid ?? '')}** — 4 события`);
  });
  it('длинное имя берётся раньше короткого, а часть слова ссылкой не становится', () => {
    const r = linkifyNodes('nl-2 и nl, но не nlx и не anl', N);
    expect(r).toBe(`${link('nl-2', N[2]?.uuid ?? '')} и ${link('nl', N[1]?.uuid ?? '')}, но не nlx и не anl`);
  });
  it('код, блоки кода и готовые ссылки не трогаются', () => {
    const src =
      'Команда `ping nl` и\n```\nping nl\n```\nи [nl](https://x.example) остаются как есть, а nl — нет';
    const r = linkifyNodes(src, N);
    expect(r).toContain('`ping nl`');
    expect(r).toContain('```\nping nl\n```');
    expect(r).toContain('[nl](https://x.example)');
    expect(r.endsWith(`а ${link('nl', N[1]?.uuid ?? '')} — нет`)).toBe(true);
  });
  it('старые ссылки на серверы остаются как есть: ноду поверх них не подставляем', () => {
    const uuid = '11111111-1111-4111-8111-111111111111';
    const old = `[старый](server:${uuid})`;
    expect(linkifyNodes(`Нода и ${old} и \`Нода\``, [{ uuid, name: 'Нода' }])).toBe(
      `[Нода](node:${uuid}) и ${old} и \`Нода\``,
    );
  });
  it('пустой список и слишком короткие имена — текст без изменений', () => {
    expect(linkifyNodes('nl', [])).toBe('nl');
    expect(linkifyNodes('a', [{ uuid: 'x', name: 'a' }])).toBe('a');
  });
  it('регулярные символы в имени экранируются', () => {
    const r = linkifyNodes('узел a.b+c работает', [
      { uuid: '44444444-4444-4444-8444-444444444444', name: 'a.b+c' },
    ]);
    expect(r).toContain('[a.b+c](node:');
    expect(linkifyNodes('узел aXb+c', [{ uuid: 'x', name: 'a.b+c' }])).toBe('узел aXb+c');
  });
  it('одинаковые имена у разных нод не угадываются', () => {
    expect(
      linkifyNodes('Нода', [
        { uuid: 'a', name: 'Нода' },
        { uuid: 'b', name: 'Нода' },
      ]),
    ).toBe('Нода');
  });
});
