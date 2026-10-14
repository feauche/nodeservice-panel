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

describe('DNS: свой адрес вместо адреса ноды', () => {
  /** Служба с «базой» в памяти: записи, связи, отметки «свой адрес» и настройки автозамены. */
  function own(over: Record<string, unknown> = {}) {
    const f = fixture();
    const rows = new Map<string, unknown>([
      ['dns.settings.panel', { automaticNodes: [], automaticRecords: [f.record.id] }],
    ]);
    f.internals.read = async (key) => rows.get(key) ?? null;
    f.internals.write = async (key, value) => {
      rows.set(key, value);
    };
    const record = { ...f.record, ...over };
    vi.mocked(f.service.overview).mockResolvedValue({ records: [record], errors: [] } as never);
    vi.mocked(f.service.settings).mockImplementation(
      async () =>
        (rows.get('dns.settings.panel') ?? { automaticNodes: [], automaticRecords: [] }) as {
          automaticNodes: string[];
          automaticRecords: string[];
        },
    );
    const send = (address: string, id = record.id, expected = record.content) =>
      f.service.apply({ recordId: id, address, expected });
    return { ...f, rows, record, send };
  }

  it('запись с нодой: уходит свой адрес, связь с нодой не меняется, запись помечена, автозамена выключена', async () => {
    const f = own();
    await expect(f.send('203.0.113.10')).resolves.toMatchObject({
      changed: true,
      own: true,
      to: '203.0.113.10',
    });
    expect(f.providerRequest).toHaveBeenCalledWith(
      'cloudflare',
      expect.stringContaining('/dns_records/record'),
      'PATCH',
      { content: '203.0.113.10' },
      undefined,
      expect.anything(),
    );
    expect(f.rows.get('dns.custom.panel')).toEqual({ [f.record.id]: '203.0.113.10' });
    expect(f.rows.has('dns.links.panel')).toBe(false);
    expect(f.rows.get('dns.settings.panel')).toEqual({ automaticNodes: [], automaticRecords: [] });
  });

  it('в журнал замен попадает пометка «свой адрес»', async () => {
    const f = own();
    await f.send('203.0.113.10');
    expect(f.internals.log).toHaveBeenCalledWith(
      expect.objectContaining({ custom: true, next: '203.0.113.10', status: 'success', automatic: false }),
    );
  });

  it('адрес не того вида — отказ по-русски, к провайдеру не ходим', async () => {
    const f = own();
    await expect(f.send('2001:db8::1')).rejects.toThrow('Введите IPv4-адрес');
    await expect(f.send('не адрес')).rejects.toThrow('Введите IPv4-адрес');
    expect(f.providerRequest).not.toHaveBeenCalled();
    const v6 = own({ type: 'AAAA', content: '2001:db8::1' });
    await expect(v6.send('203.0.113.10')).rejects.toThrow('Введите IPv6-адрес');
  });

  it('IPv6 приводится к привычному виду: заглавные и нули не создают «другой» адрес', async () => {
    const f = own({ type: 'AAAA', content: '2001:db8::1' });
    await expect(f.send('2001:DB8:0:0:0:0:0:1')).resolves.toMatchObject({ changed: false, own: true });
    expect(f.providerRequest).not.toHaveBeenCalled();
    expect(f.rows.get('dns.custom.panel')).toEqual({ [f.record.id]: '2001:db8::1' });
    await expect(f.send('2001:db8::2', f.record.id, '2001:db8::1')).resolves.toMatchObject({ changed: true });
    expect(f.providerRequest).toHaveBeenCalledWith(
      'cloudflare',
      expect.any(String),
      'PATCH',
      { content: '2001:db8::2' },
      undefined,
      expect.anything(),
    );
  });

  it('запись без ноды тоже меняется своим адресом и ничего не пишет о ноде', async () => {
    const f = own({ nodes: [] });
    await expect(f.send('198.51.100.7')).resolves.toMatchObject({ changed: true, own: true });
    expect(f.rows.get('dns.custom.panel')).toEqual({ [f.record.id]: '198.51.100.7' });
    expect(f.rows.has('dns.links.panel')).toBe(false);
  });

  it('адрес уже такой — запись не трогаем, но отмечаем как «свой»', async () => {
    const f = own();
    await expect(f.send('192.0.2.1')).resolves.toMatchObject({ changed: false, own: true });
    expect(f.providerRequest).not.toHaveBeenCalled();
    expect(f.rows.get('dns.custom.panel')).toEqual({ [f.record.id]: '192.0.2.1' });
  });

  it('следом замена адресом ноды снимает отметку «свой адрес»', async () => {
    const f = own();
    await f.send('203.0.113.10');
    vi.mocked(f.service.overview).mockResolvedValue({
      records: [{ ...f.record, content: '203.0.113.10', custom: true }],
      errors: [],
    } as never);
    await f.service.apply({ recordId: f.record.id, nodeUuid: 'node-b', expected: '203.0.113.10' });
    expect(f.rows.get('dns.custom.panel')).toEqual({});
    expect(f.rows.get('dns.links.panel')).toEqual({ [f.record.id]: 'node-b' });
  });

  it('у записи со своим адресом автозамену включить нельзя', async () => {
    const f = own({ custom: true });
    await expect(f.service.setSettings(f.record.id, true)).rejects.toThrow('У записи свой адрес');
  });

  it('REG.RU: номер записи включает адрес — отметка и настройки переезжают на новую запись', async () => {
    const reg = vi.fn().mockResolvedValue({});
    const f = fixture();
    const record = {
      id: 'regru|zone|www:A:192.0.2.1',
      provider: 'regru',
      zone: 'example.com',
      zoneId: 'zone',
      recordId: 'www:A:192.0.2.1',
      subname: 'www',
      name: 'www.example.com',
      type: 'A',
      content: '192.0.2.1',
      ttl: 600,
      nodes: [],
    };
    const moved = {
      ...record,
      id: 'regru|zone|www:A:203.0.113.10',
      recordId: 'www:A:203.0.113.10',
      content: '203.0.113.10',
    };
    const service = f.service as unknown as { integrations: { reg: typeof reg } };
    service.integrations.reg = reg;
    const rows = new Map<string, unknown>([
      ['dns.settings.panel', { automaticNodes: [], automaticRecords: [] }],
    ]);
    f.internals.read = async (key) => rows.get(key) ?? null;
    f.internals.write = async (key, value) => void rows.set(key, value);
    vi.mocked(f.service.overview)
      .mockResolvedValueOnce({ records: [record], errors: [] } as never)
      .mockResolvedValue({ records: [record, moved], errors: [] } as never);
    await f.service.apply({ recordId: record.id, address: '203.0.113.10', expected: '192.0.2.1' });
    expect(reg).toHaveBeenCalledWith(
      'zone/add_alias',
      expect.objectContaining({ ipaddr: '203.0.113.10' }),
      expect.anything(),
    );
    expect(reg).toHaveBeenCalledWith(
      'zone/remove_record',
      expect.objectContaining({ content: '192.0.2.1' }),
      expect.anything(),
    );
    expect(rows.get('dns.custom.panel')).toEqual({ [moved.id]: '203.0.113.10' });
  });
});

describe('DNS: смена адреса ноды не переписывает записи со своим адресом', () => {
  it('автозамена не трогает запись, в событии ноды — «оставлена со своим адресом»', async () => {
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
      content: '203.0.113.10',
      custom: true,
      nodes: [{ uuid: 'node-b', name: 'Нидерланды', address: '192.0.2.2' }],
    };
    const internals = service as unknown as Record<string, unknown>;
    internals.scope = vi.fn().mockResolvedValue('scope-a');
    internals.keyFor = vi.fn(async (kind: string) => `dns.${kind}.panel`);
    internals.read = vi.fn(async (key: string) =>
      key === 'dns.addresses.panel' ? { 'node-b': '192.0.2.1' } : {},
    );
    internals.write = vi.fn().mockResolvedValue(undefined);
    vi.spyOn(service, 'overview').mockResolvedValue({
      records: [record],
      domains: [{ name: 'example.ru', provider: 'cloudflare', hosts: [] }],
      errors: [],
    } as never);
    vi.spyOn(service, 'settings').mockResolvedValue({ automaticNodes: [], automaticRecords: [record.id] });
    await service.runTick();
    expect(providerRequest).not.toHaveBeenCalled();
    expect(noteNode).toHaveBeenCalledWith(
      'node-b',
      expect.objectContaining({
        tone: 'info',
        action: 'DNS-запись nl1.example.ru оставлена со своим адресом',
        detail: 'Адрес ноды сменился на 192.0.2.2, а запись ведёт на 203.0.113.10 — вы поставили его сами.',
      }),
    );
  });
});

describe('DNS: отметка «свой адрес» при чтении записей', () => {
  function reading(marks: Record<string, string>, content = '203.0.113.10') {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ response: { hosts: [] } }), { status: 200 })),
    );
    const providerRequest = vi.fn(async (_provider: string, path: string) =>
      path.startsWith('/zones/')
        ? {
            success: true,
            result: [{ id: 'r1', type: 'A', name: 'wall.example.com', content, ttl: 300 }],
            result_info: { total_pages: 1 },
          }
        : { success: true, result: [{ id: 'z1', name: 'example.com' }], result_info: { total_pages: 1 } },
    );
    const service = new DnsService(
      {} as never,
      { status: async (p: string) => ({ connected: p === 'cloudflare' }), providerRequest } as never,
      {
        credentials: async () => ({ domain: 'panel.test', apiKey: 'k' }),
        domain: async () => 'panel.test',
      } as never,
      { status: async () => ({ nodes: [] }) } as never,
    );
    const internals = service as unknown as Record<string, unknown> & {
      load: () => Promise<{ records: Array<{ custom: boolean }> }>;
    };
    internals.keyFor = vi.fn(async (kind: string) => `dns.${kind}.panel`);
    internals.read = vi.fn(async (key: string) => (key === 'dns.custom.panel' ? marks : null));
    internals.write = vi.fn().mockResolvedValue(undefined);
    return internals;
  }
  it('запись ведёт на адрес, который поставил владелец, — помечена', async () => {
    const svc = reading({ 'cloudflare|z1|r1': '203.0.113.10' });
    expect((await svc.load()).records[0]?.custom).toBe(true);
  });
  it('адрес поменяли в самом Cloudflare — отметка снимается сама', async () => {
    const svc = reading({ 'cloudflare|z1|r1': '203.0.113.10' }, '198.51.100.9');
    expect((await svc.load()).records[0]?.custom).toBe(false);
  });
  it('без отметки запись обычная', async () => {
    const svc = reading({});
    expect((await svc.load()).records[0]?.custom).toBe(false);
  });
});
