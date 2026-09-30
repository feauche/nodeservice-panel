import {
  DEFAULT_SERVER_COUNTRY,
  DEFAULT_SERVER_PROFILE,
  EMPTY_FACTS,
  type OverviewServerMetrics,
  type Server,
} from '@nodeservice/shared';
import { describe, expect, it } from 'vitest';

import { HEALTH_LABELS, serverHealth, serverState } from './server-health';

const base: Server = {
  id: '11111111-1111-4111-8111-111111111111',
  name: 's',
  host: '203.0.113.7',
  port: 22,
  sshUser: 'root',
  authMethod: 'panel-key',
  tags: [],
  notes: null,
  providerId: null,
  nodeWatch: 'auto',
  nodeLink: 'auto',
  country: DEFAULT_SERVER_COUNTRY,
  profile: DEFAULT_SERVER_PROFILE,
  inventory: null,
  drift: [],
  node: null,
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
  it('один признак связи из двух — «внимание» с названной причиной: сервер работает', () => {
    // SSH не пустил, а агент на связи (fail2ban, закрытый снаружи порт, сменившийся отпечаток).
    expect(serverState({ ...base, sshOk: false })).toEqual({
      health: 'warn',
      about: 'link',
      reason: 'SSH не пускает',
    });
    // Агент молчит, а по SSH панель заходит (агент не достукивается до панели).
    expect(serverState({ ...base, agentStatus: 'offline' })).toEqual({
      health: 'warn',
      about: 'link',
      reason: 'Агент не на связи',
    });
    // SSH ещё не проверяли — о втором признаке панель не знает ничего: «недоступен» утверждать рано.
    expect(serverState({ ...base, agentStatus: 'offline', sshOk: null })).toMatchObject({
      health: 'warn',
      reason: 'Агент не на связи',
    });
  });

  it('оба признака связи пропали — «недоступен», с обеими причинами', () => {
    expect(serverState({ ...base, agentStatus: 'offline', sshOk: false })).toEqual({
      health: 'crit',
      about: 'link',
      reason: 'Недоступен: SSH не пускает, агент молчит',
    });
  });

  it('сервер без агента: SSH — единственный признак связи, без него сервер «недоступен»', () => {
    expect(serverState({ ...base, agentStatus: 'not_installed', sshOk: false })).toMatchObject({
      health: 'crit',
      reason: 'Недоступен: SSH не пускает, агента нет',
    });
    expect(serverState({ ...base, agentStatus: 'pending', sshOk: false })).toMatchObject({
      health: 'crit',
      reason: 'Недоступен: SSH не пускает, агент молчит',
    });
    expect(serverState({ ...base, agentStatus: 'installing', sshOk: false })).toMatchObject({
      health: 'crit',
      reason: 'Недоступен: SSH не пускает, агент устанавливается',
    });
  });

  it('агент не поставлен или SSH не проверяли — внимание', () => {
    expect(serverState({ ...base, agentStatus: 'not_installed' })).toEqual({
      health: 'warn',
      about: 'link',
      reason: 'Агент не установлен',
    });
    expect(serverState({ ...base, agentStatus: 'installing' })).toMatchObject({
      health: 'warn',
      reason: 'Агент устанавливается',
    });
    expect(serverState({ ...base, agentStatus: 'pending' })).toMatchObject({
      health: 'warn',
      reason: 'Ожидает агента',
    });
    expect(serverState({ ...base, sshOk: null })).toEqual({
      health: 'warn',
      about: 'link',
      reason: 'SSH не проверен',
    });
  });

  it('нода остановлена или не найдена при включённом слежении — критично, хотя сервер на связи', () => {
    expect(serverState({ ...base, node: 'stopped' })).toEqual({
      health: 'crit',
      about: 'node',
      reason: 'Нода остановлена',
    });
    expect(serverState({ ...base, node: 'none', nodeWatch: 'on' })).toMatchObject({
      health: 'crit',
      reason: 'Нода не найдена',
    });
    // «Определять автоматически»: контейнера нет — значит, ноды на сервере и не должно быть.
    expect(serverHealth({ ...base, node: 'none', nodeWatch: 'auto' })).toBe('ok');
    // Слежение выключено — остановленный контейнер не судим (так же, как детекция инцидентов).
    expect(serverHealth({ ...base, node: 'stopped', nodeWatch: 'off' })).toBe('ok');
    expect(serverHealth({ ...base, node: 'running' })).toBe('ok');
  });

  it('порядок причин: нет связи важнее ноды, нода важнее одного признака связи и нагрузки', () => {
    // До сервера не достучаться — что с нодой, панель не знает: последнее увиденное не называем.
    expect(serverState({ ...base, agentStatus: 'offline', sshOk: false, node: 'stopped' }).reason).toBe(
      'Недоступен: SSH не пускает, агент молчит',
    );
    expect(serverState({ ...base, sshOk: false, node: 'stopped' })).toMatchObject({
      health: 'crit',
      reason: 'Нода остановлена',
    });
    expect(serverState({ ...base, node: 'stopped' }, m({ cpuPct: 99 })).reason).toBe('Нода остановлена');
    expect(serverState({ ...base, sshOk: false }, m({ cpuPct: 99 })).reason).toBe('SSH не пускает');
  });

  it('ресурсы на пределе — внимание с цифрой, иначе норма без причины', () => {
    expect(serverState(base, m({ cpuPct: 90.4 }))).toEqual({
      health: 'warn',
      about: 'load',
      reason: 'CPU 90%',
    });
    expect(serverState(base, m({ memPct: 95 }))).toMatchObject({ health: 'warn', reason: 'Память 95%' });
    expect(serverState(base, m({ diskPct: 91 }))).toMatchObject({ health: 'warn', reason: 'Диск 91%' });
    expect(serverState(base, m({}))).toEqual({ health: 'ok', about: null, reason: null });
    expect(serverHealth(base)).toBe('ok');
  });

  it('подписи уровней не называют сервер выключенным: что он «офлайн», панель не знает', () => {
    for (const label of Object.values(HEALTH_LABELS)) expect(label).not.toMatch(/офлайн/i);
    expect(HEALTH_LABELS.crit).toBe('Сбой');
  });
});
