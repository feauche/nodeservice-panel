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
    keyFor: (kind: string) => Promise<string>;
    read: (key: string) => Promise<unknown>;
    write: (key: string, data: unknown) => Promise<void>;
    log: () => Promise<void>;
  };
  internals.scope = vi.fn().mockResolvedValue('scope-a');
  // Настройки и связи — по адресу панели Remnawave (см. keyFor), а не по отпечатку доступов.
  internals.keyFor = vi.fn(async (kind: string) => `dns.${kind}.panel`);
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
    await expect(f.service.apply(f.body)).resolves.toMatchObject({
      changed: true,
      domain: 'node.example.com',
    });
    expect(f.internals.write).toHaveBeenCalledWith('dns.links.panel', { [f.record.id]: 'node-b' });
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
    expect(rows.get('dns.links.panel')).toEqual({ [f.record.id]: 'node-b', [second.id]: 'node-b' });
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
        (rows.get('dns.settings.panel') ?? { automaticNodes: [], automaticRecords: [] }) as {
          automaticNodes: string[];
          automaticRecords: string[];
        },
    );
    vi.mocked(f.service.overview).mockResolvedValue({ records: [f.record, second], errors: [] } as never);
    await Promise.all([f.service.setSettings(f.record.id, true), f.service.setSettings(second.id, true)]);
    expect(rows.get('dns.settings.panel')).toEqual({
      automaticNodes: [],
      automaticRecords: [f.record.id, second.id],
    });
  });
});

describe('DNS: автозамена и связи не теряются при смене токена провайдера', () => {
  /** Служба с настоящим keyFor: старые ключи с отпечатком доступов лежат в «базе». */
  function withRows(rows: Array<{ key: string; value: unknown; at: number }>) {
    const store = new Map<string, unknown>(rows.map((r) => [r.key, r.value]));
    const db = {
      select: () => ({
        from: () => ({
          where: () => ({
            orderBy: async () =>
              [...rows]
                .sort((a, b) => b.at - a.at)
                .map((r) => ({ key: r.key, value: JSON.stringify(r.value), updatedAt: new Date(r.at) })),
          }),
        }),
      }),
    };
    const service = new DnsService(
      db as never,
      {} as never,
      { domain: async () => 'panel.test' } as never,
      {} as never,
    );
    const internals = service as unknown as {
      read: (key: string) => Promise<unknown>;
      write: (key: string, value: unknown) => Promise<void>;
      keyFor: (kind: 'settings' | 'links') => Promise<string>;
    };
    internals.read = async (key) => store.get(key) ?? null;
    internals.write = async (key, value) => {
      store.set(key, value);
    };
    return { service, internals, store };
  }
  it('настройки автозамены переносятся с ключа старого токена — последние по времени', async () => {
    const f = withRows([
      { key: 'dns.settings.panel.old.none', value: { automaticNodes: [], automaticRecords: ['a'] }, at: 1 },
      {
        key: 'dns.settings.panel.newer.none',
        value: { automaticNodes: [], automaticRecords: ['a', 'b'] },
        at: 2,
      },
    ]);
    await expect(f.service.settings()).resolves.toEqual({ automaticNodes: [], automaticRecords: ['a', 'b'] });
    expect(f.store.get('dns.settings.panel.test')).toEqual({
      automaticNodes: [],
      automaticRecords: ['a', 'b'],
    });
  });
  it('связи «запись → нода» со всех старых ключей собираются вместе, свежие поверх старых', async () => {
    const f = withRows([
      { key: 'dns.links.panel.old.none', value: { r1: 'node-1', r2: 'node-old' }, at: 1 },
      { key: 'dns.links.panel.newer.none', value: { r2: 'node-2', r3: 'node-3' }, at: 2 },
    ]);
    expect(await f.internals.keyFor('links')).toBe('dns.links.panel.test');
    expect(f.store.get('dns.links.panel.test')).toEqual({ r1: 'node-1', r2: 'node-2', r3: 'node-3' });
  });
});

describe('DNS: шаги в событии ноды после смены адреса', () => {
  function moved(automatic: boolean) {
    const noteNode = vi.fn(async () => 1);
    const providerRequest = vi.fn().mockResolvedValue({ success: true });
    const service = new DnsService(
      {} as never,
      { session: async () => ({ identity: 'account-a' }), providerRequest } as never,
      {} as never,
      {
        status: async () => ({
          connected: true,
          error: null,
          domain: 'panel',
          nodes: [{ uuid: 'node-b', address: '192.0.2.2' }],
        }),
      } as never,
      undefined,
      { noteNode } as never,
    );
    const record = {
      id: 'cloudflare|zone|record',
      provider: 'cloudflare',
      zoneId: 'zone',
      recordId: 'record',
      name: 'nl1.example.ru',
      type: 'A',
      content: '192.0.2.1',
      nodes: [{ uuid: 'node-b', address: '192.0.2.2' }],
    };
    const internals = service as unknown as Record<string, unknown>;
    internals.scope = vi.fn().mockResolvedValue('scope-a');
    internals.keyFor = vi.fn(async (kind: string) => `dns.${kind}.panel`);
    // Прежний адрес ноды — 192.0.2.1: в Remnawave его сменили на 192.0.2.2.
    internals.read = vi.fn(async (key: string) =>
      key === 'dns.addresses.panel' ? { 'node-b': '192.0.2.1' } : { [record.id]: 'node-b' },
    );
    internals.write = vi.fn().mockResolvedValue(undefined);
    internals.log = vi.fn().mockResolvedValue(undefined);
    vi.spyOn(service, 'overview').mockResolvedValue({
      records: [record],
      domains: [{ name: 'example.ru', provider: 'cloudflare', hosts: [] }],
      errors: [],
    } as never);
    vi.spyOn(service, 'settings').mockResolvedValue({
      automaticNodes: [],
      automaticRecords: automatic ? [record.id] : [],
    });
    return { service, noteNode, providerRequest, record };
  }
  it('автозамена включена: запись обновляется, в событии «обновлена автоматически»; тот же шаг дважды не пишется', async () => {
    const f = moved(true);
    await f.service.runTick();
    expect(f.providerRequest).toHaveBeenCalledOnce();
    expect(f.noteNode).toHaveBeenCalledWith(
      'node-b',
      expect.objectContaining({
        step: 'dns',
        tone: 'ok',
        action: 'DNS-запись nl1.example.ru обновлена автоматически',
        detail: '192.0.2.1 → 192.0.2.2',
      }),
    );
    await f.service.runTick();
    expect(f.noteNode).toHaveBeenCalledOnce();
  });
  it('автозамена не включена: «ведёт на старый адрес», что сделать, и кнопка к записи', async () => {
    const f = moved(false);
    await f.service.runTick();
    expect(f.providerRequest).not.toHaveBeenCalled();
    expect(f.noteNode).toHaveBeenCalledWith(
      'node-b',
      expect.objectContaining({
        tone: 'warn',
        action: 'DNS-запись nl1.example.ru ведёт на старый адрес',
        detail:
          'Автозамена для этой записи не включена. Замените 192.0.2.1 на 192.0.2.2 вручную или включите автозамену — дальше событие закроется само.',
        link: {
          label: 'Открыть запись в DNS-интеграциях',
          to: '/integrations/dns',
          search: { record: 'cloudflare|zone|record' },
        },
      }),
    );
  });
  it('сервис отказал: «не удалось обновить» с причиной по-русски, повтор через минуту', async () => {
    const f = moved(true);
    f.providerRequest.mockResolvedValue({ success: false });
    await f.service.runTick();
    expect(f.noteNode).toHaveBeenCalledWith(
      'node-b',
      expect.objectContaining({
        tone: 'crit',
        action: 'Не удалось обновить DNS-запись nl1.example.ru',
        detail: 'DNS-сервис отклонил изменение. Повторю через минуту; запись можно заменить вручную.',
      }),
    );
  });
  it('ручная замена в «DNS интеграциях» — строка «обновлена вручную» в событии ноды', async () => {
    const f = moved(false);
    await f.service.apply({ recordId: f.record.id, nodeUuid: 'node-b', expected: '192.0.2.1' });
    expect(f.noteNode).toHaveBeenCalledWith(
      'node-b',
      expect.objectContaining({
        tone: 'ok',
        action: 'DNS-запись nl1.example.ru обновлена вручную',
        detail: '192.0.2.1 → 192.0.2.2',
      }),
    );
  });
});
