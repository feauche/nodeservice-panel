import { describe, expect, it } from 'vitest';

import type { RemnawaveTopologySource } from './remnawave-client.js';
import { buildRemnawaveTopology } from './remnawave-topology.logic.js';

const source = (): RemnawaveTopologySource => ({
  hosts: [
    {
      uuid: 'host-1',
      remark: 'Вход Россия',
      address: 'ru.example.com',
      port: 443,
      nodes: ['node-ru'],
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
});
