import { describe, expect, it } from 'vitest';

import type { RemnawaveTopologySource } from './remnawave-client.js';
import { buildRemnawaveTopology, topologyAddresses } from './remnawave-topology.logic.js';

const source = (): RemnawaveTopologySource => ({
  hosts: [
    {
      uuid: 'host-1',
      remark: 'Вход Россия',
      address: 'ru.example.com',
      port: 443,
      inbound: { configProfileUuid: 'profile-1', configProfileInboundUuid: 'in-1' },
    },
  ],
  nodes: [
    {
      uuid: 'node-ru',
      name: 'Россия - 1',
      address: '10.0.0.1',
      countryCode: 'RU',
      isConnected: true,
      isDisabled: false,
      configProfile: {
        activeConfigProfileUuid: 'profile-1',
        activeInbounds: [{ uuid: 'in-1' }],
      },
    },
    {
      uuid: 'node-nl',
      name: 'Нидерланды - 1',
      address: '10.0.0.2',
      countryCode: 'NL',
      isConnected: false,
      isDisabled: false,
      configProfile: { activeConfigProfileUuid: 'profile-1', activeInbounds: [] },
    },
  ],
  profiles: [
    {
      uuid: 'profile-1',
      name: 'Основной',
      inbounds: [
        {
          uuid: 'in-1',
          tag: 'VLESS_IN',
          type: 'vless',
          network: 'tcp',
          security: 'reality',
          port: 443,
        },
      ],
      config: {
        routing: {
          rules: [{ inboundTag: ['VLESS_IN'], domain: ['geosite:youtube'], outboundTag: 'NL_OUT' }],
        },
        outbounds: [
          { tag: 'DIRECT', protocol: 'freedom' },
          { tag: 'NL_OUT', protocol: 'vless', settings: { vnext: [{ address: '10.0.0.2' }] } },
        ],
      },
    },
  ],
  metrics: [{ nodeUuid: 'node-ru', usersOnline: 42 }],
});

describe('buildRemnawaveTopology', () => {
  it('связывает хост, инбаунд, ноды и выход без секретных полей', () => {
    const result = buildRemnawaveTopology(source(), new Map([['node-ru', ['server-1']]]));
    expect(result.hosts[0]).toMatchObject({
      id: 'host-1',
      inboundTag: 'VLESS_IN',
      protocol: 'vless',
      nodeUuids: ['node-ru'],
      status: 'ok',
    });
    expect(result.nodes[0]).toMatchObject({ usersOnline: 42, serverIds: ['server-1'] });
    expect(result.routes.find((route) => route.outboundTag === 'NL_OUT')).toMatchObject({
      hostIds: ['host-1'],
      targetKind: 'node',
      targetNodeUuids: ['node-nl'],
      status: 'error',
      confidence: 'confirmed',
    });
    expect(JSON.stringify(result)).not.toContain('privateKey');
  });

  it('не считает хост отвязанным, если его инбаунд активен на ноде', () => {
    const input = source();
    (input.hosts[0] as Record<string, unknown>).nodes = [];

    const result = buildRemnawaveTopology(input);

    expect(result.hosts[0]).toMatchObject({ nodeUuids: ['node-ru'], status: 'ok' });
    expect(result.issues).not.toContainEqual(expect.objectContaining({ kind: 'host_no_nodes' }));
  });

  it('при общем профиле связывает хост только с нодой, на которую указывает DNS', () => {
    const input = source();
    (input.nodes[1] as Record<string, unknown>).configProfile = {
      activeConfigProfileUuid: 'profile-1',
      activeInbounds: [{ uuid: 'in-1' }],
    };

    const result = buildRemnawaveTopology(input, new Map(), new Map([['ru.example.com', ['10.0.0.2']]]));

    expect(result.hosts[0]).toMatchObject({ nodeUuids: ['node-nl'], status: 'error' });
  });

  it('сообщает о проблеме, только если инбаунд хоста не запущен ни на одной ноде', () => {
    const input = source();
    (input.nodes[0] as Record<string, unknown>).configProfile = {
      activeConfigProfileUuid: 'profile-1',
      activeInbounds: [],
    };

    const result = buildRemnawaveTopology(input);

    expect(result.hosts[0]).toMatchObject({ nodeUuids: [], status: 'warning' });
    expect(result.issues).toContainEqual(
      expect.objectContaining({ kind: 'host_no_nodes', severity: 'warning' }),
    );
  });

  it('не выдумывает ноду для неизвестного сервисного выхода', () => {
    const input = source();
    const profile = input.profiles[0] as Record<string, unknown>;
    profile.config = {
      routing: { rules: [{ outboundTag: 'CUSTOM' }] },
      outbounds: [
        { tag: 'CUSTOM', protocol: 'socks', settings: { servers: [{ address: 'proxy.internal' }] } },
      ],
    };
    const route = buildRemnawaveTopology(input).routes[0];
    expect(route).toMatchObject({
      targetKind: 'service',
      targetLabel: 'CUSTOM',
      confidence: 'unknown',
      status: 'unknown',
    });
    expect(route?.note).toContain('связать его с нодой');
  });

  it('сопоставляет outbound с выходной нодой через DNS', () => {
    const input = source();
    const profile = input.profiles[0] as Record<string, unknown>;
    profile.config = {
      routing: { rules: [{ outboundTag: 'BRIDGE_NL' }] },
      outbounds: [
        {
          tag: 'BRIDGE_NL',
          protocol: 'vless',
          settings: { vnext: [{ address: 'bridge-nl.example.com' }] },
        },
      ],
    };
    const resolved = new Map<string, readonly string[]>([
      ['bridge-nl.example.com', ['10.0.0.2']],
      ['10.0.0.2', ['10.0.0.2']],
    ]);

    expect(topologyAddresses(input)).toContain('bridge-nl.example.com');
    expect(buildRemnawaveTopology(input, new Map(), resolved).routes[0]).toMatchObject({
      targetKind: 'node',
      targetLabel: 'Нидерланды - 1',
      targetNodeUuids: ['node-nl'],
      confidence: 'confirmed',
    });
  });

  it('проходит цепочку dialerProxy и обнаруживает циклическую ссылку', () => {
    const input = source();
    const profile = input.profiles[0] as Record<string, unknown>;
    profile.config = {
      routing: { rules: [{ outboundTag: 'CHAIN' }] },
      outbounds: [
        { tag: 'CHAIN', protocol: 'freedom', streamSettings: { sockopt: { dialerProxy: 'NL_OUT' } } },
        { tag: 'NL_OUT', protocol: 'vless', settings: { vnext: [{ address: '10.0.0.2' }] } },
      ],
    };
    const route = buildRemnawaveTopology(input).routes[0];
    expect(route).toMatchObject({ targetKind: 'node', targetNodeUuids: ['node-nl'], status: 'error' });
    expect(route?.targetLabel).toContain('CHAIN → Нидерланды - 1');
  });

  it('разбирает первый outbound без tag как маршрут по умолчанию, а не неизвестный сервис', () => {
    const input = source();
    const profile = input.profiles[0] as Record<string, unknown>;
    profile.config = {
      routing: { rules: [] },
      outbounds: [{ protocol: 'freedom' }],
    };

    const result = buildRemnawaveTopology(input);
    const route = result.routes[0];
    expect(route).toMatchObject({
      isDefault: true,
      outboundTag: '(без тега) · freedom',
      outboundProtocol: 'freedom',
      targetKind: 'internet',
      targetLabel: 'Интернет напрямую',
      confidence: 'confirmed',
    });
    expect(route?.explanation).toContain('первый outbound');
    expect(result.profiles[0]?.outbounds[0]).toMatchObject({
      tag: null,
      protocol: 'freedom',
      purpose: 'Интернет напрямую',
    });
  });

  it('не называет любой локальный SOCKS-выход Psiphon без явного тега', () => {
    const input = source();
    const profile = input.profiles[0] as Record<string, unknown>;
    profile.config = {
      routing: { rules: [{ outboundTag: 'LOCAL_PROXY' }] },
      outbounds: [
        { tag: 'LOCAL_PROXY', protocol: 'socks', settings: { servers: [{ address: '127.0.0.1' }] } },
      ],
    };

    const route = buildRemnawaveTopology(input).routes[0];
    expect(route).toMatchObject({
      targetKind: 'service',
      targetLabel: 'LOCAL_PROXY',
      confidence: 'confirmed',
    });
    expect(route?.explanation).toContain('Назвать его Psiphon можно только');
  });

  it('строит канонический путь от клиента до интернета с отдельным outbound и выходной нодой', () => {
    const result = buildRemnawaveTopology(source());
    const path = result.paths.find((item) => item.exitNodeUuid === 'node-nl');

    expect(path).toMatchObject({
      hostId: 'host-1',
      entryNodeUuid: 'node-ru',
      exitNodeUuid: 'node-nl',
      destination: 'internet',
    });
    expect(path?.segments.map((segment) => segment.kind)).toEqual([
      'client_host',
      'host_inbound',
      'inbound_entry',
      'entry_outbound',
      'outbound_exit',
      'exit_internet',
    ]);
  });
});
