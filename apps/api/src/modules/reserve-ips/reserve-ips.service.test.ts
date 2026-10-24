import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ReserveIpsService, reserveCheck } from './reserve-ips.service.js';

const NODE = {
  uuid: '11111111-1111-4111-8111-111111111111',
  name: 'Германия - 1',
  address: '177.3.216.253',
  port: 2222,
};
const KEY = `node.reserve.panel.test:${NODE.uuid}`;
const report = (verdict: string) => ({
  verdict,
  checkedAt: '2026-10-24T09:00:00.000Z',
  target: '177.3.216.31:443',
  link: null,
  error: null,
  observations: [
    {
      node: 'ru1',
      country: 'ru',
      city: 'Москва',
      state: verdict === 'reachable' ? 'ok' : 'failed',
      error: null,
    },
    {
      node: 'de1',
      country: 'de',
      city: 'Франкфурт',
      state: verdict === 'port_unreachable' ? 'failed' : 'ok',
      error: null,
    },
  ],
});

/** Ключ app_meta из условия drizzle (eq(appMeta.key, …)). */
function keyOf(where: unknown): string {
  const found: string[] = [];
  const walk = (x: unknown, depth = 0): void => {
    if (!x || depth > 6) return;
    if (typeof x === 'string') {
      if (x.startsWith('node.reserve.') || x.startsWith('monitor.tcp.')) found.push(x);
    } else if (Array.isArray(x)) for (const y of x) walk(y, depth + 1);
    else if (typeof x === 'object')
      for (const k of ['queryChunks', 'value']) walk((x as Record<string, unknown>)[k], depth + 1);
  };
  walk(where);
  return found[0] ?? KEY;
}
function fixture(
  opts: {
    nodeAddress?: string;
    nodePatch?: number;
    verdict?: string;
    verdicts?: Record<string, string>;
  } = {},
) {
  const data = new Map<string, string>();
  let node = { ...NODE, address: opts.nodeAddress ?? NODE.address };
  const patches: Array<{ url: string; body: Record<string, unknown> }> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'PATCH') {
        const body = JSON.parse(String(init.body));
        patches.push({ url, body });
        if (url.endsWith('/api/nodes') && opts.nodePatch && opts.nodePatch >= 400)
          return new Response('{}', { status: opts.nodePatch });
        if (url.endsWith('/api/nodes')) node = { ...node, address: body.address };
        return new Response(JSON.stringify({ response: body }));
      }
      return new Response(
        JSON.stringify({
          response: [
            { uuid: 'h-ip', remark: 'Германия IP', address: '177.3.216.253' },
            { uuid: 'h-domain', remark: 'Германия', address: 'de.example.com' },
          ],
        }),
      );
    }),
  );
  const db = {
    query: {
      appMeta: {
        findFirst: async ({ where }: { where: unknown }) => {
          const key = keyOf(where);
          const value = data.get(key);
          return value ? { key, value } : undefined;
        },
      },
    },
    insert: () => ({
      values: (row: { key: string; value: string }) => ({
        onConflictDoUpdate: async () => {
          data.set(row.key, row.value);
        },
      }),
    }),
  };
  const dnsRecords = [
    { id: 'r1', name: 'de.example.com', type: 'A', content: '177.3.216.253', provider: 'cloudflare' },
    { id: 'r2', name: 'other.example.com', type: 'A', content: '9.9.9.9', provider: 'cloudflare' },
  ];
  const dns = {
    overview: vi.fn(async () => ({ records: dnsRecords, errors: [] })),
    apply: vi.fn(async () => ({ changed: true })),
  };
  const events = { append: vi.fn(async () => undefined) };
  const incidents = {
    forNode: vi.fn(async () => ({ id: 'inc', title: 'Похоже на блокировку' })),
    note: vi.fn(),
  };
  const checkNode = vi.fn(async (ip: string) => report(opts.verdicts?.[ip] ?? opts.verdict ?? 'reachable'));
  const audit = { record: vi.fn(async () => null) };
  const notifications = { push: vi.fn(async () => undefined) };
  const service = new ReserveIpsService(
    db as never,
    {
      status: async () => ({ connected: true, domain: 'panel.test', nodes: [node] }),
      syncQuiet: async () => undefined,
    } as never,
    { credentials: async () => ({ domain: 'panel.test', apiKey: 'secret' }) } as never,
    { observe: async (_s: string, _c: unknown, call: () => Promise<unknown>) => call() } as never,
    { checkNode } as never,
    { get: async () => ({ checkHostPort: 443 }) } as never,
    dns as never,
    events as never,
    incidents as never,
    audit as never,
    notifications as never,
  );
  return {
    service,
    data,
    patches,
    dns,
    events,
    incidents,
    checkNode,
    audit,
    notifications,
    saved: () => JSON.parse(data.get(KEY) ?? 'null'),
  };
}
afterEach(() => vi.unstubAllGlobals());

describe('Запасные IP: проверка без перевода ноды', () => {
  it('добавленный адрес сразу проверяется через Check-Host на портах ноды; итог словами', async () => {
    const f = fixture();
    const r = await f.service.add(NODE.uuid, ' 177.3.216.31 ');
    expect(f.checkNode).toHaveBeenCalledWith('177.3.216.31', 443, 2222, { confirm: false });
    expect(r.items).toEqual([
      {
        ip: '177.3.216.31',
        wasPrimaryUntil: null,
        check: expect.objectContaining({
          ok: true,
          verdict: 'reachable',
          text: 'Отвечает · из РФ 1 из 1, из других стран 1 из 1',
        }),
      },
    ]);
    // Живая нода никуда не переводилась.
    expect(f.patches).toEqual([]);
  });
  it('не адрес, внутренний, рабочий адрес ноды, повтор — отказ словами', async () => {
    const f = fixture();
    await expect(f.service.add(NODE.uuid, 'de.example.com')).rejects.toThrow('Введите IP-адрес');
    await expect(f.service.add(NODE.uuid, '10.0.0.5')).rejects.toThrow('Это внутренний адрес');
    await expect(f.service.add(NODE.uuid, '177.3.216.253')).rejects.toThrow('Это рабочий адрес ноды.');
    await f.service.add(NODE.uuid, '177.3.216.31');
    await expect(f.service.add(NODE.uuid, '177.3.216.31')).rejects.toThrow('Этот адрес уже в списке.');
  });
  it('итог Check-Host: заблокирован из России, порт закрыт, нет ответа — переключать нельзя', () => {
    expect(reserveCheck(report('russia_unreachable') as never)).toMatchObject({
      ok: false,
      text: expect.stringMatching(/^Не отвечает из России — адрес, похоже, тоже заблокирован/),
    });
    expect(reserveCheck(report('port_unreachable') as never).text).toBe(
      'Не отвечает ниоткуда — порт закрыт или адрес не на этом сервере',
    );
    expect(reserveCheck({ ...report('unknown'), error: 'нет точек' } as never)).toMatchObject({ ok: false });
  });
});

describe('Запасные IP: переключение', () => {
  it('план: адрес ноды, Host с этим IP (Host на доменах не трогаются), записи DNS со старым IP', async () => {
    const f = fixture();
    await f.service.add(NODE.uuid, '177.3.216.31');
    const plan = await f.service.plan(NODE.uuid, '177.3.216.31');
    expect(plan.blocked).toBeNull();
    expect(plan.steps.map((s) => [s.kind, s.title, s.detail])).toEqual([
      ['node', 'Адрес ноды в Remnawave', '177.3.216.253 → 177.3.216.31'],
      ['host', 'Host «Германия IP»', '177.3.216.253 → 177.3.216.31'],
      ['dns', 'de.example.com · Cloudflare', 'A 177.3.216.253 → 177.3.216.31'],
    ]);
  });
  it('адрес ноды — домен: переключать нечего, так и сказано', async () => {
    const f = fixture({ nodeAddress: 'de-node.example.com' });
    const plan = await f.service.plan(NODE.uuid, '177.3.216.31');
    expect(plan.blocked).toMatch(/^Адрес ноды в Remnawave — домен «de-node\.example\.com»/);
  });
  it('переключение: Remnawave, Host, DNS по шагам; старый адрес — в запасных с отметкой, след в событиях', async () => {
    const f = fixture();
    await f.service.add(NODE.uuid, '177.3.216.31');
    const r = await f.service.switchTo(NODE.uuid, '177.3.216.31', 'manual');
    expect(f.patches).toEqual([
      { url: 'https://panel.test/api/nodes', body: { uuid: NODE.uuid, address: '177.3.216.31' } },
      { url: 'https://panel.test/api/hosts', body: { uuid: 'h-ip', address: '177.3.216.31' } },
    ]);
    expect(f.dns.apply).toHaveBeenCalledWith({
      recordId: 'r1',
      nodeUuid: NODE.uuid,
      expected: '177.3.216.253',
    });
    expect(r.plan.steps.every((s) => s.ok === true)).toBe(true);
    expect(r.reserve.items).toEqual([
      { ip: '177.3.216.253', check: null, wasPrimaryUntil: expect.any(String) },
    ]);
    expect(r.reserve.lastSwitch).toMatchObject({ from: '177.3.216.253', to: '177.3.216.31', by: 'manual' });
    expect(f.events.append).toHaveBeenCalledWith(
      'panel.test',
      expect.objectContaining({
        type: 'automation',
        title: 'Нода переключена на запасной IP',
        summary: '177.3.216.253 → 177.3.216.31, вручную · DNS: 1 · Host: 1',
      }),
    );
    expect(f.incidents.note).toHaveBeenCalledWith(
      'inc',
      expect.stringMatching(/^Нода переключена на запасной IP/),
      'applied',
    );
  });
  it('Remnawave отказала в смене адреса — Host и DNS не трогаются, список не меняется', async () => {
    const f = fixture({ nodePatch: 403 });
    await f.service.add(NODE.uuid, '177.3.216.31');
    const r = await f.service.switchTo(NODE.uuid, '177.3.216.31', 'manual');
    expect(f.patches).toHaveLength(1);
    expect(f.dns.apply).not.toHaveBeenCalled();
    expect(r.plan.steps[0]).toMatchObject({
      ok: false,
      error: 'У ключа Remnawave нет права «Изменение нод» (nodes:update) — адрес не изменён.',
    });
    expect(r.plan.steps.slice(1).every((s) => s.ok === false)).toBe(true);
    expect(r.reserve.items.map((i) => i.ip)).toEqual(['177.3.216.31']);
  });
});

describe('Запасные IP: «Переключать само» и сценарий', () => {
  const MONITOR = `monitor.tcp.${createHash('sha256').update('panel.test').digest('hex').slice(0, 16)}.${NODE.uuid}`;
  const reserve = (extra: Record<string, unknown> = {}) =>
    JSON.stringify({
      auto: true,
      lastSwitch: null,
      items: [
        { ip: '177.3.216.32', check: null, wasPrimaryUntil: null },
        { ip: '177.3.216.31', check: null, wasPrimaryUntil: null },
      ],
      ...extra,
    });
  const probe = (verdict: string, minutesAgo = 5, address = NODE.address) =>
    JSON.stringify({
      address,
      report: { ...report(verdict), checkedAt: new Date(Date.now() - minutesAgo * 60_000).toISOString() },
    });

  it('по порядку: первый не отвечает — берётся следующий; запись в «Журнал» от панели', async () => {
    const f = fixture({ verdicts: { '177.3.216.32': 'port_unreachable', '177.3.216.31': 'reachable' } });
    f.data.set(KEY, reserve());
    const r = await f.service.failover(NODE.uuid, 'scenario');
    expect(r).toMatchObject({ switched: true, plan: { to: '177.3.216.31' } });
    expect(f.checkNode.mock.calls.map(([ip]) => ip)).toEqual(['177.3.216.32', '177.3.216.31']);
    expect(f.audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'incident.node_reserve.switched', source: 'auto' }),
    );
    expect(f.saved().items.find((i: { ip: string }) => i.ip === '177.3.216.32').check.ok).toBe(false);
  });

  it('ни один не отвечает — ничего не трогает, причина в событии ноды', async () => {
    const f = fixture({ verdict: 'russia_unreachable' });
    f.data.set(KEY, reserve());
    const r = await f.service.failover(NODE.uuid, 'auto');
    expect(r).toMatchObject({ switched: false });
    expect(f.patches).toEqual([]);
    expect(f.events.append).toHaveBeenCalledWith(
      'panel.test',
      expect.objectContaining({ title: 'Запасные IP не отвечают — нода не переключена' }),
    );
  });

  it('«само»: свежая проверка «из России закрыт» — переключает и сообщает; иначе не трогает', async () => {
    const f = fixture();
    f.data.set(KEY, reserve());
    f.data.set(MONITOR, probe('reachable'));
    await f.service.runAuto();
    expect(f.patches).toEqual([]);
    f.data.set(MONITOR, probe('russia_unreachable', 45));
    await f.service.runAuto();
    expect(f.patches).toEqual([]);
    f.data.set(MONITOR, probe('russia_unreachable'));
    await f.service.runAuto();
    expect(f.patches[0]?.body).toEqual({ uuid: NODE.uuid, address: '177.3.216.32' });
    expect(f.notifications.push).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Нода переключена на запасной IP · Германия - 1' }),
    );
    // Не чаще раза в сутки.
    f.patches.length = 0;
    await f.service.runAuto();
    expect(f.patches).toEqual([]);
  });

  it('«само» выключено — не трогает даже при блокировке', async () => {
    const f = fixture();
    f.data.set(KEY, reserve({ auto: false }));
    f.data.set(MONITOR, probe('russia_unreachable'));
    await f.service.runAuto();
    expect(f.checkNode).not.toHaveBeenCalled();
  });
});
