import type { Incident, Server } from '@nodeservice/shared';
import { describe, expect, it, vi } from 'vitest';

import {
  findServer,
  incidentCase,
  type ReadDeps,
  runReadTool,
  summarizeSeries,
} from './assistant.read-tools.js';

const ID_A = '0192c000-0000-7000-8000-00000000000a';
const ID_B = '0192c000-0000-7000-8000-00000000000b';

const server = (over: Partial<Server>): Server =>
  ({
    id: ID_A,
    name: 'de-1',
    host: '10.0.0.1',
    port: 22,
    sshUser: 'root',
    authMethod: 'panel-key',
    tags: ['de'],
    notes: null,
    providerId: null,
    nodeWatch: 'auto',
    node: 'running',
    facts: { os: 'Ubuntu', osVersion: '24.04', arch: 'x86_64', cpuCores: 2, memoryMb: 2048 },
    hostKeyFingerprint: 'SHA256:secret-fingerprint',
    agentStatus: 'online',
    agentVersion: '0.5.4',
    agentLastSeenAt: '2026-09-25T10:00:00.000Z',
    sshOk: true,
    lastSshCheckAt: null,
    lastSshOkAt: null,
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    ...over,
  }) as Server;

const incident = (over: Partial<Incident>): Incident =>
  ({
    id: '0192c000-0000-7000-8000-0000000000e1',
    serverId: ID_A,
    serverName: 'de-1',
    kind: 'disk_high',
    severity: 'warn',
    status: 'open',
    title: 'Диск заполнен на 91 %',
    detail: 'Занято 91 %',
    openedAt: '2026-09-25T09:00:00.000Z',
    resolvedAt: null,
    resolvedBy: null,
    timeline: [{ at: '2026-09-25T09:00:00.000Z', by: 'auto', action: 'detect', result: 'detect' }],
    attempts: [],
    proposal: null,
    snapshot: { cpu: 5, mem: 40, disk: 91, node: 'running', agentStatus: 'online', agentVersion: '0.5.4' },
    ...over,
  }) as Incident;

function deps(over: Partial<Record<keyof ReadDeps, unknown>> = {}): ReadDeps {
  return {
    servers: { list: async () => [server({}), server({ id: ID_B, name: 'nl-2', node: 'stopped' })] },
    incidents: {
      list: async () => ({ items: [incident({})], counts: { open: 1, crit: 0, warn: 1 } }),
      get: async () => incident({}),
    },
    metrics: { query: async () => null, queryRange: async () => null },
    incidentMetrics: {
      latest: async () => ({ cpu: new Map([[ID_A, 12.345]]), mem: new Map(), disk: new Map([[ID_A, 91]]) }),
    },
    providers: { list: async () => [] },
    maintenance: {
      state: async () => ({
        serverId: ID_A,
        check: null,
        checkError: null,
        nextCheckAt: null,
        running: null,
        lastRun: null,
      }),
    },
    ...over,
  } as unknown as ReadDeps;
}

const call = async (name: string, arg: Record<string, unknown>, d = deps()) => {
  const out = await runReadTool(name, arg, d);
  if (!out) throw new Error('инструмент не распознан');
  // biome-ignore lint/suspicious/noExplicitAny: разбор JSON в тесте
  return { out, json: () => JSON.parse(out.content) as Record<string, any> };
};

describe('findServer', () => {
  const list = [server({}), server({ id: ID_B, name: 'de-2' })];
  it('находит по id, точному имени и однозначной части имени', () => {
    expect(findServer(list, ID_B)?.name).toBe('de-2');
    expect(findServer(list, 'DE-1')?.id).toBe(ID_A);
    expect(findServer([server({}), server({ id: ID_B, name: 'nl-2' })], 'nl')?.id).toBe(ID_B);
  });
  it('неоднозначное и пустое не угадывает', () => {
    expect(findServer(list, 'de')).toBeUndefined();
    expect(findServer(list, '  ')).toBeUndefined();
    expect(findServer(list, 'нет такого')).toBeUndefined();
  });
});

describe('summarizeSeries', () => {
  it('считает пик, среднее и тренд', () => {
    const pts: Array<[number, number]> = [10, 12, 11, 30, 55, 70, 90, 95, 96].map((v, i) => [
      1000 + i * 60,
      v,
    ]);
    const s = summarizeSeries(pts);
    expect(s).toMatchObject({ samples: 9, last: 96, min: 10, max: 96, trend: 'растёт' });
    expect(s?.peakAt).toBe(new Date((1000 + 8 * 60) * 1000).toISOString());
    expect(s?.points.length).toBeLessThanOrEqual(12);
  });
  it('ровная линия — «ровно», падение — «падает»', () => {
    expect(summarizeSeries([1, 2, 3, 4, 5, 6].map((i) => [i, 50] as [number, number]))?.trend).toBe('ровно');
    expect(summarizeSeries([90, 80, 60, 30, 20, 10].map((v, i) => [i, v] as [number, number]))?.trend).toBe(
      'падает',
    );
  });
  it('пустой ряд и NaN — null', () => {
    expect(summarizeSeries([])).toBeNull();
    expect(summarizeSeries([[1, Number.NaN]])).toBeNull();
  });
  it('длинный ряд ужимается до 12 точек и сохраняет последнюю', () => {
    const pts = Array.from({ length: 500 }, (_, i) => [i, i] as [number, number]);
    const s = summarizeSeries(pts);
    expect(s?.points.length).toBeLessThanOrEqual(12);
    expect(s?.points.at(-1)?.v).toBe(499);
  });
});

describe('get_fleet_status', () => {
  it('даёт итоги, метрики в процентах и открытые инциденты по серверу, без секретов', async () => {
    const { out, json } = await call('get_fleet_status', {});
    const j = json();
    expect(j.totals).toMatchObject({ servers: 2, nodeStopped: 1, openIncidents: 1, agentOnline: 2 });
    const a = j.servers.find((s: { name: string }) => s.name === 'de-1');
    expect(a).toMatchObject({ cpuPct: 12.35, diskPct: 91, memPct: null });
    expect(a.openIncidents).toHaveLength(1);
    expect(out.content).not.toContain('secret-fingerprint');
  });
});

describe('get_server_detail', () => {
  it('ищет по имени и берёт аптайм из своей метрики, а не из CPU', async () => {
    const query = vi.fn(async (q: string) =>
      q.startsWith('nodeservice_uptime_sec')
        ? [{ labels: {}, points: [[1, 7200]] as Array<[number, number]> }]
        : [],
    );
    const { json } = await call(
      'get_server_detail',
      { serverId: 'de-1' },
      deps({ metrics: { query, queryRange: async () => null } }),
    );
    const j = json();
    expect(j.metrics.uptimeSec).toBe(7200);
    expect(j.metrics.cpuPct).toBeNull();
    expect(j.openIncidents).toHaveLength(1);
    expect(JSON.stringify(j)).not.toContain('secret-fingerprint');
  });
  it('неизвестный сервер — подсказка со списком имён', async () => {
    const { out } = await call('get_server_detail', { serverId: 'xx' });
    expect(out.content).toContain('de-1');
    expect(out.content).toContain('nl-2');
  });
});

describe('get_metrics_history', () => {
  it('возвращает сводку и подставляет id сервера в запрос, а не ввод модели', async () => {
    const queryRange = vi.fn(async () => [
      {
        labels: {},
        points: [
          [1, 10],
          [2, 20],
          [3, 90],
        ] as Array<[number, number]>,
      },
    ]);
    const { json } = await call(
      'get_metrics_history',
      { serverId: 'de-1', metric: 'diskPct', range: '24h' },
      deps({ metrics: { query: async () => null, queryRange } }),
    );
    expect(json()).toMatchObject({ server: 'de-1', metric: 'diskPct', unit: '%', range: '24h', max: 90 });
    expect((queryRange.mock.calls[0] as unknown[])[0]).toContain(`server_id="${ID_A}"`);
  });
  it('неизвестная метрика и неверный диапазон', async () => {
    expect((await call('get_metrics_history', { serverId: 'de-1', metric: 'foo' })).out.content).toContain(
      'Неизвестная метрика',
    );
    const queryRange = vi.fn(async () => []);
    const r = await call(
      'get_metrics_history',
      { serverId: 'de-1', metric: 'cpuPct', range: 'год' },
      deps({ metrics: { query: async () => null, queryRange } }),
    );
    expect(r.out.content).toContain('данных');
    expect(r.out.content).toContain('1h');
  });
  it('VictoriaMetrics недоступна — честное сообщение', async () => {
    const { out } = await call('get_metrics_history', { serverId: 'de-1', metric: 'cpuPct' });
    expect(out.content).toContain('недоступно');
  });
});

describe('list_incidents / get_incident', () => {
  const many = ['a', 'b', 'c'].map((x, i) =>
    incident({
      id: `0192c000-0000-7000-8000-0000000000f${i}`,
      title: x,
      openedAt: `2026-09-2${i + 1}T00:00:00.000Z`,
    }),
  );
  it('новые сверху, лимит и фильтр по серверу', async () => {
    const d = deps({
      incidents: {
        list: async () => ({ items: many, counts: { open: 3, crit: 0, warn: 3 } }),
        get: async () => many[0],
      },
    });
    const { json } = await call('list_incidents', { limit: 2 }, d);
    expect(json().items.map((i: { title: string }) => i.title)).toEqual(['c', 'b']);
    const none = await call('list_incidents', { serverId: 'nl-2' }, d);
    expect(none.json().items).toHaveLength(0);
  });
  it('get_incident: цепочка с пометкой «уже пробовали» и хвост лога', async () => {
    const inc = incident({
      attempts: [
        {
          id: 'x1',
          action: 'free_disk',
          level: 'T1',
          by: 'auto',
          status: 'not_helped',
          startedAt: '2026-09-25T09:01:00.000Z',
          finishedAt: '2026-09-25T09:01:20.000Z',
          steps: [{ key: 'action', status: 'ok' }] as never,
          log: `${'x'.repeat(2000)}КОНЕЦ`,
        },
      ],
    });
    const c = incidentCase(inc);
    expect(c.chain.find((s) => s.key === 'free_disk')?.tried).toBe(true);
    expect(c.chain.find((s) => s.key === 'tmp_clean')?.tried).toBe(false);
    expect(c.attempts[0]?.logTail.endsWith('КОНЕЦ')).toBe(true);
    expect(c.attempts[0]?.logTail.length).toBeLessThan(800);
    expect(c.lastFix).toMatchObject({ result: 'не помогло', by: 'auto' });
  });
  it('get_incident: нет такого — подсказка', async () => {
    const d = deps({
      incidents: {
        list: async () => ({ items: [], counts: { open: 0, crit: 0, warn: 0 } }),
        get: async () => {
          throw new Error('404');
        },
      },
    });
    expect((await call('get_incident', { incidentId: 'zzz' }, d)).out.content).toContain('не найден');
  });
});

describe('get_maintenance', () => {
  it('отдаёт состояние без логов запусков', async () => {
    const { json } = await call('get_maintenance', { serverId: 'de-1' });
    expect(json()).toMatchObject({ server: 'de-1', check: null, lastRun: null });
  });
});

it('чужое имя инструмента — null, чтобы отработал основной исполнитель', async () => {
  expect(await runReadTool('search_kb', {}, deps())).toBeNull();
});
