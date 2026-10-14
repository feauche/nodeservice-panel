import { describe, expect, it } from 'vitest';

import { expandSnippets, parseSnippets, snippetRefs } from './remnawave-snippets.js';

const SNIPPETS = [
  { name: 'Block Private', snippet: [{ ip: ['geoip:private'], outboundTag: 'BLOCK' }] },
  {
    name: 'warp',
    snippet: [
      { tag: 'WARP', protocol: 'wireguard' },
      { tag: 'WARP-2', protocol: 'wireguard' },
    ],
  },
  { name: 'one', snippet: { tag: 'ONE', protocol: 'freedom' } },
  { name: 'dns', snippet: [{ dns: { servers: ['1.1.1.1'] } }, { log: { loglevel: 'warning' } }] },
];

describe('сниппеты Remnawave (как при сборке конфига ноды)', () => {
  it('ответ GET /api/snippets — список имён и содержимого', () => {
    expect(
      parseSnippets({
        response: { total: 2, snippets: [{ name: 'a', snippet: [{ x: 1 }] }, { snippet: [] }] },
      }),
    ).toEqual([{ name: 'a', snippet: [{ x: 1 }] }]);
    expect(parseSnippets({})).toEqual([]);
  });

  it('массив сниппета встаёт на место ссылки всеми объектами, с пометкой откуда', () => {
    const { config, used } = expandSnippets(
      { outbounds: [{ tag: 'DIRECT' }, { snippet: 'warp' }, { tag: 'BLOCK' }] },
      SNIPPETS,
    );
    expect(config).toEqual({
      outbounds: [
        { tag: 'DIRECT' },
        { tag: 'WARP', protocol: 'wireguard', _fromSnippet: 'warp' },
        { tag: 'WARP-2', protocol: 'wireguard', _fromSnippet: 'warp' },
        { tag: 'BLOCK' },
      ],
    });
    expect(used).toEqual(['warp']);
  });

  it('объект сниппета заменяет ссылку; правила и балансировщики тоже раскрываются', () => {
    const { config } = expandSnippets(
      {
        outbounds: [{ snippet: 'one' }],
        routing: { rules: [{ snippet: 'Block Private' }], balancers: [{ snippet: 'one' }] },
      },
      SNIPPETS,
    );
    expect(config).toMatchObject({
      outbounds: [{ tag: 'ONE', _fromSnippet: 'one' }],
      routing: {
        rules: [{ ip: ['geoip:private'], outboundTag: 'BLOCK', _fromSnippet: 'Block Private' }],
        balancers: [{ tag: 'ONE', _fromSnippet: 'one' }],
      },
    });
  });

  it('ссылка на неизвестный сниппет пропадает — как в Remnawave — и называется отдельно', () => {
    const { config, missing } = expandSnippets(
      { outbounds: [{ snippet: 'gone' }, { tag: 'DIRECT' }] },
      SNIPPETS,
    );
    expect(config).toEqual({ outbounds: [{ tag: 'DIRECT' }] });
    expect(missing).toEqual([{ name: 'gone', where: 'outbounds' }]);
  });

  it('корневые сниппеты дописывают ключи, которых в конфиге нет; inbounds и существующие не трогают', () => {
    const { config, used } = expandSnippets(
      { log: { loglevel: 'none' }, inbounds: [], snippets: ['dns'] },
      SNIPPETS,
    );
    expect(config).toEqual({
      log: { loglevel: 'none' },
      inbounds: [],
      dns: { servers: ['1.1.1.1'] },
      _rootSnippets: { dns: ['dns'] },
    });
    expect(used).toEqual(['dns']);
  });

  it('исходный конфиг не меняется, а какие сниппеты использует профиль — видно без раскрытия', () => {
    const original = { outbounds: [{ snippet: 'warp' }], routing: { rules: [{ snippet: 'Block Private' }] } };
    const copy = structuredClone(original);
    expandSnippets(original, SNIPPETS);
    expect(original).toEqual(copy);
    expect(snippetRefs(original)).toEqual(['warp', 'Block Private']);
    expect(snippetRefs(null)).toEqual([]);
  });
});
