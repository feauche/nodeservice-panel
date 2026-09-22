import { EMPTY_FACTS, type OverviewServerMetrics, type Server } from '@nodeservice/shared';
import { describe, expect, it } from 'vitest';

import { serverHealth } from './server-health';

const base: Server = {
  id: '11111111-1111-4111-8111-111111111111',
  name: 's',
  host: '203.0.113.7',
  port: 22,
  sshUser: 'root',
  authMethod: 'panel-key',
  tags: [],
  notes: null,
  facts: EMPTY_FACTS,
  hostKeyFingerprint: null,
  agentStatus: 'online',
  agentVersion: null,
  agentLastSeenAt: null,
  sshOk: true,
  lastSshCheckAt: null,
  lastSshOkAt: null,
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-01T00:00:00.000Z',
};
const m = (p: Partial<OverviewServerMetrics>): OverviewServerMetrics => ({
  serverId: base.id,
  cpuPct: 10,
  memPct: 10,
  diskPct: 10,
  netRxBps: 0,
  netTxBps: 0,
  uptimeSec: 0,
  cpuSpark: [],
  ...p,
});

describe('serverHealth', () => {
  it('SSH не отвечает или агент пропал — офлайн', () => {
    expect(serverHealth({ ...base, sshOk: false })).toBe('crit');
    expect(serverHealth({ ...base, agentStatus: 'offline' })).toBe('crit');
  });
  it('агент не поставлен или SSH не проверяли — внимание', () => {
    expect(serverHealth({ ...base, agentStatus: 'not_installed' })).toBe('warn');
    expect(serverHealth({ ...base, agentStatus: 'pending' })).toBe('warn');
    expect(serverHealth({ ...base, sshOk: null })).toBe('warn');
  });
  it('ресурсы на пределе — внимание, иначе норма', () => {
    expect(serverHealth(base, m({ cpuPct: 90 }))).toBe('warn');
    expect(serverHealth(base, m({ memPct: 95 }))).toBe('warn');
    expect(serverHealth(base, m({ diskPct: 91 }))).toBe('warn');
    expect(serverHealth(base, m({}))).toBe('ok');
    expect(serverHealth(base)).toBe('ok');
  });
});
