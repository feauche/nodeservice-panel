import type { RemnawaveTopologyHost } from '@nodeservice/shared';
import { describe, expect, it } from 'vitest';
import { maskKey, matchLinks, nodeKey, parseLink } from './subscription-keys.js';

const ID = '3f9a1b2c-0000-4000-8000-00000000c21e';
const link = (address: string, port: number, remark: string, protocol = 'vless') =>
  `${protocol}://${ID}@${address}:${port}?security=reality&sni=www.microsoft.com&type=tcp#${encodeURIComponent(remark)}`;
const host = (
  id: string,
  nodes: string[],
  extra: Partial<RemnawaveTopologyHost> = {},
): RemnawaveTopologyHost => ({
  id,
  name: `Host ${id}`,
  address: `${id}.example.com`,
  port: 443,
  disabled: false,
  profileUuid: null,
  inboundUuid: null,
  inboundTag: null,
  protocol: 'vless',
  network: 'tcp',
  security: 'reality',
  nodeUuids: nodes,
  addressResolved: true,
  status: 'ok',
  ...extra,
});
const config = (hostUuid: string, address: string, remark: string, protocol = 'vless') => ({
  hostUuid,
  address,
  port: 443,
  remark,
  protocol,
});

describe('Ключи подписки: какой ключ какому Host', () => {
  it('разбирает ссылку: адрес, порт, имя по-русски; не ссылка — null', () => {
    expect(parseLink(link('DE.example.com', 443, '🇩🇪 Германия'))).toEqual({
      protocol: 'vless',
      address: 'de.example.com',
      port: 443,
      remark: '🇩🇪 Германия',
    });
    expect(parseLink('не ссылка')).toBeNull();
  });

  it('по адресу, порту и имени; имя другое — по адресу, если такая ссылка одна; одна ссылка — одному Host', () => {
    const links = [link('a.example.com', 443, 'Германия'), link('b.example.com', 443, 'Польша · 30 дней')];
    const entries = matchLinks(
      [
        config('a', 'a.example.com', 'Германия'),
        config('b', 'b.example.com', 'Польша'),
        config('c', 'a.example.com', 'Германия'),
      ],
      links,
    );
    expect(entries.map((e) => [e.hostUuid, e.link])).toEqual([
      ['a', links[0]],
      ['b', links[1]],
      ['c', null],
    ]);
  });

  it('ключ для показа: идентификатор пользователя скрыт', () => {
    expect(maskKey(link('a.example.com', 443, 'Германия'))).toMatch(
      /^vless:\/\/3f9a…c21e@a\.example\.com:443\?/,
    );
  });
});

describe('Ключ VLESS для ноды', () => {
  const entries = matchLinks(
    [config('shared', 'shared.example.com', 'Общий'), config('own', 'own.example.com', 'Германия')],
    [link('shared.example.com', 443, 'Общий'), link('own.example.com', 443, 'Германия')],
  );

  it('сначала Host только этой ноды, даже если общий стоит в подписке выше', () => {
    const k = nodeKey(
      'n1',
      [host('shared', ['n1', 'n2']), host('own', ['n1'])],
      entries,
      'nodeservice-check',
    );
    expect(k).toMatchObject({ ok: true, shared: false, host: { uuid: 'own', address: 'own.example.com' } });
  });

  it('только общий Host — берётся он, с пометкой', () => {
    const k = nodeKey('n2', [host('shared', ['n1', 'n2'])], entries, 'nodeservice-check');
    expect(k).toMatchObject({ ok: true, shared: true, host: { uuid: 'shared' } });
  });

  it('причины словами: нет Host VLESS, Host отключены, Host нет в подписке', () => {
    const svc = 'nodeservice-check';
    expect(nodeKey('n3', [host('hy', ['n3'], { protocol: 'hysteria' })], entries, svc)).toEqual({
      ok: false,
      reason: 'У ноды нет Host с VLESS в Remnawave.',
    });
    expect(nodeKey('n1', [host('own', ['n1'], { disabled: true })], entries, svc)).toEqual({
      ok: false,
      reason: 'Host ноды отключены — в подписке их нет. Вставьте ключ вручную.',
    });
    expect(nodeKey('n4', [host('other', ['n4'])], entries, svc)).toEqual({
      ok: false,
      reason: 'Host ноды нет в подписке «nodeservice-check» — дайте пользователю сквад с этой нодой.',
    });
  });
});
