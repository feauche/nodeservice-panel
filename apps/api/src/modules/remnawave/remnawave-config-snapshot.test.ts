import type { RemnawaveTopology } from '@nodeservice/shared';
import { describe, expect, it } from 'vitest';

import {
  diffTopologySnapshots,
  safeTopologySnapshot,
  topologySnapshotHash,
} from './remnawave-config-snapshot.js';

const topology = (address = '10.0.0.1'): RemnawaveTopology => ({
  generatedAt: '2026-10-06T10:00:00.000Z',
  hosts: [],
  nodes: [],
  routes: [
    {
      id: 'route-1',
      profileUuid: 'profile-1',
      profileName: 'Main',
      order: 0,
      isDefault: true,
      match: ['остальной трафик'],
      inboundTags: [],
      hostIds: [],
      outboundTag: 'bridge-nl',
      outboundProtocol: 'vless',
      outboundAddress: address,
      dialerProxy: null,
      targetKind: 'node',
      targetLabel: 'bridge-nl',
      targetNodeUuids: [],
      status: 'ok',
      confidence: 'confirmed',
      note: null,
      explanation: 'Безопасное описание',
    },
  ],
  paths: [],
  readiness: [],
  profiles: [],
  issues: [],
  configSnapshot: null,
  summary: { hosts: 0, nodes: 0, routes: 1, errors: 0, warnings: 0 },
  note: 'x',
});

describe('снимки конфигурации Remnawave', () => {
  it('игнорирует runtime-поля и находит понятное изменение адреса outbound', () => {
    const before = safeTopologySnapshot(topology());
    const afterTopology = topology('10.0.0.2');
    afterTopology.generatedAt = '2026-10-06T11:00:00.000Z';
    const route = afterTopology.routes[0];
    if (route) route.status = 'error';
    const after = safeTopologySnapshot(afterTopology);
    expect(topologySnapshotHash(before)).not.toBe(topologySnapshotHash(after));
    expect(diffTopologySnapshots(before, after)).toContainEqual({
      kind: 'route',
      entityId: 'route-1',
      label: 'Main → bridge-nl',
      field: 'Адрес выхода',
      before: '10.0.0.1',
      after: '10.0.0.2',
    });
  });
});
