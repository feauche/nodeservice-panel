import { describe, expect, it, vi } from 'vitest';
import { DnsService } from './dns.service.js';

function fixture() {
  const providerRequest = vi.fn().mockResolvedValue({ success: true });
  const service = new DnsService(
    {} as never,
    { session: async () => ({ identity: 'account-a' }), providerRequest } as never,
    {} as never,
    { status: async () => ({ nodes: [{ uuid: 'node-b', address: '192.0.2.2' }] }) } as never,
  );
  const record = {
    id: 'cloudflare|zone|record',
    provider: 'cloudflare',
    zoneId: 'zone',
    recordId: 'record',
    name: 'node.example.com',
    type: 'A',
    content: '192.0.2.1',
    nodes: [{ uuid: 'node-b', address: '192.0.2.2' }],
  };
  const internals = service as unknown as {
    scope: () => Promise<string>;
    read: (key: string) => Promise<unknown>;
    write: (key: string, data: unknown) => Promise<void>;
    log: () => Promise<void>;
  };
  internals.scope = vi.fn().mockResolvedValue('scope-a');
  internals.read = vi.fn().mockResolvedValue({ [record.id]: 'node-a' });
  internals.write = vi.fn().mockResolvedValue(undefined);
  internals.log = vi.fn().mockResolvedValue(undefined);
  vi.spyOn(service, 'overview').mockResolvedValue({ records: [record] } as never);
  vi.spyOn(service, 'settings').mockResolvedValue({ automaticNodes: [], automaticRecords: [record.id] });
  return {
    service,
    internals,
    providerRequest,
    record,
    body: { recordId: record.id, nodeUuid: 'node-b', expected: record.content },
  };
}

describe('DNS binding and automation isolation', () => {
  it('persists the selected node for a stable Cloudflare record after a manual replacement', async () => {
    const f = fixture();
    await expect(f.service.apply(f.body)).resolves.toEqual({ changed: true });
    expect(f.internals.write).toHaveBeenCalledWith('dns.links.scope-a', { [f.record.id]: 'node-b' });
    expect(f.providerRequest).toHaveBeenCalledOnce();
  });
  it('does not carry an old automation permission into another account', async () => {
    const f = fixture();
    await expect(f.service.apply(f.body, true, 'old-scope')).rejects.toThrow('Подключение изменилось');
    expect(f.providerRequest).not.toHaveBeenCalled();
  });
  it('rechecks automation permission immediately before a write', async () => {
    const f = fixture();
    vi.mocked(f.service.settings).mockResolvedValue({ automaticNodes: [], automaticRecords: [] });
    await expect(f.service.apply(f.body, true, 'scope-a')).rejects.toThrow('выключено');
    expect(f.providerRequest).not.toHaveBeenCalled();
  });
  it('does not update another record of the same node', async () => {
    const f = fixture();
    vi.mocked(f.service.settings).mockResolvedValue({
      automaticNodes: [],
      automaticRecords: ['cloudflare|zone|other'],
    });
    await expect(f.service.apply(f.body, true, 'scope-a')).rejects.toThrow('выключено');
    expect(f.providerRequest).not.toHaveBeenCalled();
  });
  it('rejects a credential switch while refreshing DNS records', async () => {
    const f = fixture();
    vi.mocked(f.internals.scope).mockResolvedValueOnce('scope-a').mockResolvedValueOnce('scope-b');
    await expect(f.service.apply(f.body, true, 'scope-a')).rejects.toThrow('Подключение изменилось');
    expect(f.providerRequest).not.toHaveBeenCalled();
  });
});

describe('DNS settings survive independent updates', () => {
  it('retains unavailable provider records when toggling one loaded record', async () => {
    const f = fixture();
    vi.spyOn(f.service, 'overview').mockResolvedValue({
      records: [f.record],
      errors: ['REG.RU недоступен'],
    } as never);
    vi.mocked(f.service.settings).mockResolvedValue({
      automaticNodes: [],
      automaticRecords: ['regru|zone|saved'],
    });
    await expect(f.service.setSettings(f.record.id, true)).resolves.toEqual({
      automaticNodes: [],
      automaticRecords: ['regru|zone|saved', f.record.id],
    });
  });
  it('preserves both bindings when different records are changed concurrently', async () => {
    const f = fixture();
    const second = { ...f.record, id: 'cloudflare|zone|second', recordId: 'second' };
    const rows = new Map<string, unknown>();
    f.internals.read = async (key) => {
      await Promise.resolve();
      return rows.get(key) ?? null;
    };
    f.internals.write = async (key, value) => {
      await Promise.resolve();
      rows.set(key, value);
    };
    vi.mocked(f.service.overview).mockResolvedValue({ records: [f.record, second] } as never);
    await Promise.all([f.service.apply(f.body), f.service.apply({ ...f.body, recordId: second.id })]);
    expect(rows.get('dns.links.scope-a')).toEqual({ [f.record.id]: 'node-b', [second.id]: 'node-b' });
  });
  it('serializes independent record switches without losing either setting', async () => {
    const f = fixture();
    const second = { ...f.record, id: 'cloudflare|zone|second' };
    const rows = new Map<string, unknown>();
    f.internals.read = async (key) => {
      await Promise.resolve();
      return rows.get(key) ?? null;
    };
    f.internals.write = async (key, value) => {
      await Promise.resolve();
      rows.set(key, value);
    };
    vi.mocked(f.service.settings).mockImplementation(
      async () =>
        (rows.get('dns.settings.scope-a') ?? { automaticNodes: [], automaticRecords: [] }) as {
          automaticNodes: string[];
          automaticRecords: string[];
        },
    );
    vi.mocked(f.service.overview).mockResolvedValue({ records: [f.record, second], errors: [] } as never);
    await Promise.all([f.service.setSettings(f.record.id, true), f.service.setSettings(second.id, true)]);
    expect(rows.get('dns.settings.scope-a')).toEqual({
      automaticNodes: [],
      automaticRecords: [f.record.id, second.id],
    });
  });
});
