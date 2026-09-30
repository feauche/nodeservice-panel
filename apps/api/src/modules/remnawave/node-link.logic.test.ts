import { describe, expect, it } from 'vitest';

import { hostsToResolve, type LinkServer, linkNodes, NodeLinks } from './node-link.logic.js';

const server = (over: Partial<LinkServer> & { name: string; host: string }): LinkServer => ({
  id: `s-${over.name}`,
  nodeLink: 'auto',
  facts: {
    hostname: null,
    os: null,
    osVersion: null,
    arch: null,
    kernel: null,
    cpuCores: null,
    memoryMb: null,
    addresses: [],
  },
  ...over,
});
const withIps = (s: LinkServer, addresses: string[]): LinkServer => ({
  ...s,
  facts: { ...s.facts, addresses },
});
const node = (name: string, address: string, uuid = `n-${name}`) => ({ uuid, name, address });
const NONE = new Map<string, string[]>();

describe('linkNodes: какая нода Remnawave на каком сервере', () => {
  it('совпал адрес — связь по адресу; регистр, пробелы и точка в конце не мешают', () => {
    const rows = linkNodes(
      [server({ name: 'Германия - 1', host: 'DE1.Example.com' })],
      [node('de-1', ' de1.example.com. ')],
      NONE,
    );
    expect(rows).toEqual([{ serverId: 's-Германия - 1', nodeUuid: 'n-de-1', by: 'address' }]);
  });

  it('случай владельца: сервер добавлен по домену, нода в Remnawave — по IP', () => {
    const resolved = new Map([['nl1.example.com', ['201.34.145.175']]]);
    const rows = linkNodes(
      [server({ name: 'Нидерланды - 1', host: 'nl1.example.com' })],
      [node('Нидерланды - 1', '201.34.145.175')],
      resolved,
    );
    expect(rows).toEqual([{ serverId: 's-Нидерланды - 1', nodeUuid: 'n-Нидерланды - 1', by: 'ip' }]);
    // Домен не разрешился — связи нет: гадать по одному названию панель не станет.
    expect(
      linkNodes(
        [server({ name: 'Нидерланды - 1', host: 'nl1.example.com' })],
        [node('Нидерланды - 1', '201.34.145.175')],
        NONE,
      ),
    ).toEqual([]);
  });

  it('и наоборот: сервер по IP, нода по домену', () => {
    const rows = linkNodes(
      [server({ name: 'fi', host: '203.0.113.10' })],
      [node('fi-node', 'fi1.vpn.example')],
      new Map([['fi1.vpn.example', ['203.0.113.10']]]),
    );
    expect(rows[0]).toMatchObject({ by: 'ip' });
  });

  it('нода записана по второму адресу сервера — находится по адресам на его интерфейсах', () => {
    const s = withIps(server({ name: 'Нидерланды - 1', host: '201.34.145.170' }), [
      '201.34.145.170',
      '201.34.145.175',
    ]);
    expect(linkNodes([s], [node('nl', '201.34.145.175')], NONE)).toEqual([
      { serverId: s.id, nodeUuid: 'n-nl', by: 'ip' },
    ]);
  });

  it('ручной выбор важнее адреса, и выбранная вручную нода автоматически никому больше не достаётся', () => {
    const a = server({ name: 'а', host: '1.1.1.1', nodeLink: 'n-чужая' });
    const b = server({ name: 'б', host: '2.2.2.2' });
    const rows = linkNodes([a, b], [node('своя', '1.1.1.1'), node('чужая', '2.2.2.2')], NONE);
    expect(rows).toEqual([{ serverId: 's-а', nodeUuid: 'n-чужая', by: 'manual' }]);
  });

  it('«Нет ноды» — связи нет, даже если адрес совпал', () => {
    expect(
      linkNodes(
        [server({ name: 'панель', host: '1.1.1.1', nodeLink: 'none' })],
        [node('x', '1.1.1.1')],
        NONE,
      ),
    ).toEqual([]);
  });

  it('выбранной вручную ноды больше нет в Remnawave — связи нет, другую панель не подставляет', () => {
    expect(
      linkNodes(
        [server({ name: 'а', host: '1.1.1.1', nodeLink: 'n-удалена' })],
        [node('x', '1.1.1.1')],
        NONE,
      ),
    ).toEqual([]);
  });

  it('две ноды на одном адресе — серверу достаётся та, чьё название совпало; адрес важнее IP', () => {
    const s = server({ name: 'Польша - 1', host: '3.3.3.3' });
    expect(linkNodes([s], [node('другая', '3.3.3.3'), node('польша - 1', '3.3.3.3')], NONE)).toEqual([
      { serverId: s.id, nodeUuid: 'n-польша - 1', by: 'address' },
    ]);
    const byDomain = server({ name: 'x', host: 'pl.example.com' });
    const resolved = new Map([['pl.example.com', ['3.3.3.3']]]);
    expect(
      linkNodes([byDomain], [node('по IP', '3.3.3.3'), node('по адресу', 'pl.example.com')], resolved),
    ).toEqual([{ serverId: byDomain.id, nodeUuid: 'n-по адресу', by: 'address' }]);
  });

  it('две записи одной машины — нода у обеих, основная — первая в списке', () => {
    const a = server({ name: 'а', host: '4.4.4.4' });
    const b = server({ name: 'б', host: '4.4.4.4' });
    const links = new NodeLinks([a, b], [node('n', '4.4.4.4')], NONE);
    expect(links.serverIdsOf('n-n')).toEqual(['s-а', 's-б']);
    expect(links.nodeOf('s-б')?.uuid).toBe('n-n');
    expect(links.byOf('s-а')).toBe('address');
    expect(links.byOf('s-нет')).toBeNull();
  });
});

describe('NodeLinks.machineIds: с каких серверов ноду проверять нельзя', () => {
  it('связанный сервер и все записи с тем же адресом или IP — даже с «Нет ноды»', () => {
    const linked = server({ name: 'связан', host: 'de.example.com' });
    const twin = server({ name: 'вторая запись', host: '5.5.5.5', nodeLink: 'none' });
    const other = server({ name: 'другой', host: '6.6.6.6' });
    const n = node('de', '5.5.5.5');
    const links = new NodeLinks([linked, twin, other], [n], new Map([['de.example.com', ['5.5.5.5']]]));
    expect(links.machineIds(n).sort()).toEqual(['s-вторая запись', 's-связан']);
  });

  it('нода без сервера в панели — исключать некого', () => {
    const n = node('чужая', '9.9.9.9');
    expect(new NodeLinks([server({ name: 'а', host: '1.1.1.1' })], [n], NONE).machineIds(n)).toEqual([]);
  });

  it('ручная связь: сервер исключается, хотя адреса разные', () => {
    const s = server({ name: 'за NAT', host: '10.0.0.5', nodeLink: 'n-nat' });
    const n = node('nat', '7.7.7.7');
    expect(new NodeLinks([s], [n], NONE).machineIds(n)).toEqual(['s-за NAT']);
  });
});

describe('NodeLinks.namesakeOf: подсказка по названию', () => {
  it('нода без сервера и сервер с тем же названием без ноды — подсказываем, но не связываем', () => {
    const s = server({ name: 'Нидерланды - 1', host: '8.8.8.1' });
    const n = node('нидерланды - 1', '201.34.145.175');
    const links = new NodeLinks([s], [n], NONE);
    expect(links.nodeOf(s.id)).toBeUndefined();
    expect(links.namesakeOf(n)?.id).toBe(s.id);
  });

  it('у сервера уже есть своя нода или стоит «Нет ноды» — не подсказываем', () => {
    const busy = server({ name: 'Нидерланды - 1', host: '8.8.8.1' });
    const n = node('Нидерланды - 1', '201.34.145.175');
    expect(new NodeLinks([busy], [node('другая', '8.8.8.1'), n], NONE).namesakeOf(n)).toBeUndefined();
    const none = server({ name: 'Нидерланды - 1', host: '8.8.8.1', nodeLink: 'none' });
    expect(new NodeLinks([none], [n], NONE).namesakeOf(n)).toBeUndefined();
  });
});

describe('hostsToResolve', () => {
  it('только домены, без повторов и без IP', () => {
    expect(
      hostsToResolve(
        [server({ name: 'а', host: 'DE.example.com' }), server({ name: 'б', host: '1.1.1.1' })],
        [node('x', 'de.example.com.'), node('y', '2a01:4f8::1'), node('z', 'fi.example.com')],
      ),
    ).toEqual(['de.example.com', 'fi.example.com']);
  });
});
