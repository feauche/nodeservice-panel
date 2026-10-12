import { describe, expect, it, vi } from 'vitest';
import { runPassiveTool, type ToolDeps } from './assistant.tools.js';

const uuid = '0192f200-0000-7000-8000-000000000001';
const node = {
  uuid,
  name: 'Нода',
  address: '1.1.1.1',
  isConnected: true,
  isDisabled: false,
  usersOnline: null,
  cpuPercent: null,
  serverIds: ['legacy'],
  linkedBy: 'ip',
};
function deps(nodes = [node]) {
  return {
    remnawave: {
      status: async () => ({
        connected: true,
        domain: 'panel.test',
        checkedAt: new Date().toISOString(),
        error: null,
        nodes,
        stats: null,
        cert: null,
      }),
    },
    servers: {
      list: vi.fn(() => {
        throw Error('legacycalled');
      }),
    },
  } as unknown as ToolDeps;
}
describe('assistant current node data boundary', () => {
  it('reads node snapshots without legacy inventory and returns explicit node citations, unknown metrics stay null', async () => {
    const d = deps(),
      out = await runPassiveTool('get_node_detail', { node: uuid }, d),
      body = JSON.parse(out.content);
    expect(out.citations).toEqual([{ type: 'node', id: uuid, label: 'Нода' }]);
    expect(body.node.cpuPercent).toBeNull();
    expect(body.node.usersOnline).toBeNull();
    expect(body.node.serverIds).toBeUndefined();
    expect(d.servers.list).not.toHaveBeenCalled();
  });
  it('does not guess ambiguous node names or convert stale snapshots into measured failure', async () => {
    const d = deps([node, { ...node, uuid: 'other' }]);
    expect((await runPassiveTool('get_node_detail', { node: 'Нода' }, d)).citations).toEqual([]);
    d.remnawave = {
      status: async () =>
        ({
          connected: true,
          domain: 'panel.test',
          checkedAt: '2020-01-01T00:00:00Z',
          error: 'sync failed',
          nodes: [node],
          stats: null,
          cert: null,
        }) as never,
    };
    const body = JSON.parse((await runPassiveTool('get_remnawave_status', {}, d)).content);
    expect(body.fresh).toBe(false);
    expect(body.nodes[0].usersOnline).toBeNull();
  });
  it('rejects unsolicited hidden tools before SSH, legacy query or writes', async () => {
    const d = deps();
    for (const name of [
      'run_server_check',
      'inspect_processes',
      'propose_change',
      'save_kb_article',
      'get_server_detail',
    ]) {
      const out = await runPassiveTool(name, { serverId: 'legacy' }, d);
      expect(out.content).toContain('недоступен');
      expect(out.proposals).toEqual([]);
    }
    expect(d.servers.list).not.toHaveBeenCalled();
  });
});

it('settings uses the current monitoring store without reading retired SSH settings', async () => {
  const d = deps();
  d.monitoring = { get: async () => ({ enabled: true, pollSeconds: 60, checkHostPort: 5492 }) };
  d.autochecks = {
    get: vi.fn(() => {
      throw Error('legacy');
    }),
  };
  d.assistant = { level: 'intermediate' };
  d.permissions = {} as never;
  const body = JSON.parse((await runPassiveTool('get_settings', {}, d)).content);
  expect(body.monitoring.pollSeconds).toBe(60);
  expect(body.autochecks).toBeUndefined();
  expect(d.autochecks.get).not.toHaveBeenCalled();
});
