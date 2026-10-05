import type { RemnawaveTopology } from '@nodeservice/shared';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { RemnawaveTopologyMap } from './remnawave-topology-map';

const topology: RemnawaveTopology = {
  generatedAt: '2026-10-05T12:00:00.000Z',
  hosts: [
    {
      id: 'host-a',
      name: 'Хост A',
      address: 'a.example.com',
      port: 443,
      disabled: false,
      profileUuid: 'shared-profile',
      inboundUuid: 'shared-inbound',
      inboundTag: 'VLESS_IN',
      protocol: 'vless',
      network: 'tcp',
      security: 'reality',
      nodeUuids: ['node-a'],
      status: 'ok',
    },
    {
      id: 'host-b',
      name: 'Хост B',
      address: 'b.example.com',
      port: 443,
      disabled: false,
      profileUuid: 'shared-profile',
      inboundUuid: 'shared-inbound',
      inboundTag: 'VLESS_IN',
      protocol: 'vless',
      network: 'tcp',
      security: 'reality',
      nodeUuids: ['node-b'],
      status: 'ok',
    },
  ],
  nodes: [
    {
      id: 'node-a',
      name: 'Нода A',
      address: '192.0.2.10',
      countryCode: 'PL',
      connected: true,
      disabled: false,
      usersOnline: 10,
      profileUuid: 'shared-profile',
      inboundUuids: ['shared-inbound'],
      serverIds: [],
      status: 'ok',
    },
    {
      id: 'node-b',
      name: 'Нода B',
      address: '192.0.2.20',
      countryCode: 'NL',
      connected: true,
      disabled: false,
      usersOnline: 20,
      profileUuid: 'shared-profile',
      inboundUuids: ['shared-inbound'],
      serverIds: [],
      status: 'ok',
    },
  ],
  routes: [
    {
      id: 'shared-profile:default',
      profileUuid: 'shared-profile',
      profileName: 'Общий профиль',
      order: 0,
      isDefault: true,
      match: ['Остальной трафик'],
      inboundTags: [],
      hostIds: ['host-a', 'host-b'],
      outboundTag: 'SERVICE',
      outboundProtocol: 'socks',
      outboundAddress: '127.0.0.1:1080',
      dialerProxy: null,
      targetKind: 'service',
      targetLabel: 'Сервисный выход',
      targetNodeUuids: [],
      status: 'ok',
      confidence: 'confirmed',
      note: null,
      explanation: 'Оба хоста используют один профиль и один выход.',
    },
  ],
  profiles: [],
  issues: [],
  summary: { hosts: 2, nodes: 2, routes: 1, errors: 0, warnings: 0 },
  note: 'Тест общей конфигурации.',
};

describe('RemnawaveTopologyMap', () => {
  it('при наведении на хост выделяет только его собственную цепочку общего профиля', async () => {
    render(<RemnawaveTopologyMap topology={topology} />);
    const user = userEvent.setup();

    await user.hover(screen.getByRole('button', { name: /Хост A/ }));

    expect(document.querySelectorAll('.ns-topology-flow')).toHaveLength(4);
    expect(screen.getByRole('button', { name: /Хост A/ })).not.toHaveClass('opacity-25');
    expect(screen.getByRole('button', { name: /Хост B/ })).toHaveClass('opacity-25');
    expect(screen.getByRole('button', { name: /Нода B/ })).toHaveClass('opacity-25');
  });
});
