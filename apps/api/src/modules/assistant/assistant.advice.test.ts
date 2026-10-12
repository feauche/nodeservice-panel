import type { RemnawaveStatus } from '@nodeservice/shared';
import { describe, expect, it } from 'vitest';

import { runTool, type ToolDeps } from './assistant.tools.js';

const UUID_DE = '0192f200-0000-7000-8000-000000000001';
const UUID_RU = '0192f200-0000-7000-8000-000000000002';

const node = (uuid: string, name: string, address: string) => ({
  uuid,
  name,
  address,
  port: 443,
  countryCode: 'DE',
  isConnected: true,
  isDisabled: false,
  isConnecting: false,
  lastStatusMessage: null,
  usersOnline: 10,
  trafficUsedBytes: null,
  trafficLimitBytes: null,
});

const status = (): RemnawaveStatus =>
  ({
    connected: true,
    domain: 'panel.example.org',
    checkedAt: new Date().toISOString(),
    error: null,
    stats: null,
    cert: null,
    nodes: [
      node(UUID_DE, 'Германия - 1', '177.3.216.253'),
      node(UUID_RU, 'Россия - 2 (hy2)', '213.171.25.240'),
    ],
  }) as unknown as RemnawaveStatus;

const deps = (whitelist: string[] = []): ToolDeps =>
  ({
    assistant: { level: 'intermediate' },
    remnawave: { status: async () => status() },
    whitelisted: async () => new Set(whitelist),
  }) as unknown as ToolDeps;

describe('совет проверки (recommend_check)', () => {
  it('находит ноду по имени и прикладывает карточку с адресом и причиной', async () => {
    const r = await runTool(
      'recommend_check',
      { check: 'tcp', node: 'германия - 1', reason: '  Remnawave не видит ноду  три проверки подряд. ' },
      deps(),
    );
    expect(r.advice).toEqual([
      {
        check: 'tcp',
        nodeUuid: UUID_DE,
        nodeName: 'Германия - 1',
        address: '177.3.216.253:443',
        reason: 'Remnawave не видит ноду три проверки подряд.',
      },
    ]);
    expect(r.citations).toEqual([{ type: 'node', id: UUID_DE, label: 'Германия - 1' }]);
    expect(r.content).toContain('Карточка совета добавлена');
  });

  it('для ноды белого списка вместо DPI Checker советует BS Checker и говорит модели почему', async () => {
    const r = await runTool(
      'recommend_check',
      { check: 'dpi', node: UUID_RU, reason: 'Из России порт закрыт.' },
      deps([UUID_RU]),
    );
    expect(r.advice?.[0]?.check).toBe('bs');
    expect(r.content).toContain('сервер белого списка');
  });

  it('обычной ноде DPI Checker остаётся DPI Checker', async () => {
    const r = await runTool(
      'recommend_check',
      { check: 'dpi', node: '177.3.216.253', reason: 'x' },
      deps([UUID_RU]),
    );
    expect(r.advice?.[0]?.check).toBe('dpi');
  });

  it('неизвестная проверка, пустая причина и не найденная нода — без карточки', async () => {
    const bad = await runTool('recommend_check', { check: 'ssh', node: UUID_DE, reason: 'x' }, deps());
    expect(bad.advice).toBeUndefined();
    expect(bad.content).toContain('Неизвестная проверка');
    const noReason = await runTool('recommend_check', { check: 'tcp', node: UUID_DE, reason: '  ' }, deps());
    expect(noReason.advice).toBeUndefined();
    const missing = await runTool(
      'recommend_check',
      { check: 'tcp', node: 'нет-такой', reason: 'x' },
      deps(),
    );
    expect(missing.advice).toBeUndefined();
    expect(missing.content).toContain('Нода не найдена');
  });

  it('в данных нод Ассистент видит отметку «Сервер белого списка»', async () => {
    const r = await runTool('get_node_detail', { node: UUID_RU }, deps([UUID_RU]));
    expect(JSON.parse(r.content).node.whitelist).toBe(true);
    const all = JSON.parse((await runTool('get_remnawave_status', {}, deps([UUID_RU]))).content);
    expect(all.nodes.map((n: { whitelist: boolean }) => n.whitelist)).toEqual([false, true]);
  });
});
