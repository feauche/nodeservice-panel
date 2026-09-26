import { ASSISTANT_PERMISSIONS_DEFAULT, type Incident, type Server } from '@nodeservice/shared';
import { describe, expect, it, vi } from 'vitest';

import {
  findServer,
  incidentCase,
  READ_TOOL_DEFS,
  type ReadDeps,
  runReadTool,
  summarizeSeries,
  toolsFor,
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
    permissions: { ...ASSISTANT_PERMISSIONS_DEFAULT, nodeLogs: true },
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

describe('check_reachability, inspect_processes, get_playbook', () => {
  it('доступность: сервер ищется по имени, результат отдаётся как есть, проверка получает список серверов парка', async () => {
    const seen: unknown[] = [];
    const d = deps({
      probe: {
        reachability: async (t: unknown, all: unknown, ports: unknown) => {
          seen.push(t, all, ports);
          return {
            target: { name: 'de-1', address: '10.0.0.1' },
            probes: [],
            ports: [],
            dns: { answers: [], consistent: true },
            notes: [],
          };
        },
        processes: async () => ({ cpu: [], mem: [], load: null, empty: true }),
      },
    });
    const { out, json } = await call('check_reachability', { serverId: 'de-1', ports: [443] }, d);
    expect(json().target.name).toBe('de-1');
    expect((seen[0] as { id: string }).id).toBe(ID_A);
    expect((seen[1] as unknown[]).length).toBe(2);
    expect(seen[2]).toEqual([443]);
    expect(out.citations[0]).toMatchObject({ type: 'server', label: 'de-1' });
    expect((await call('check_reachability', { serverId: 'нет' }, d)).out.content).toContain(
      'Доступные серверы',
    );
  });
  it('процессы: пустой ответ и ошибка SSH — честные сообщения, а не падение', async () => {
    const mk = (fn: () => Promise<unknown>) =>
      deps({ probe: { reachability: async () => ({}), processes: fn } });
    expect(
      (
        await call(
          'inspect_processes',
          { serverId: 'de-1' },
          mk(async () => ({ cpu: [], mem: [], load: null, empty: true })),
        )
      ).out.content,
    ).toContain('пустой ответ');
    expect(
      (
        await call(
          'inspect_processes',
          { serverId: 'de-1' },
          mk(async () => {
            throw new Error('ssh');
          }),
        )
      ).out.content,
    ).toContain('не ответил по SSH');
    const ok = await call(
      'inspect_processes',
      { serverId: 'de-1' },
      mk(async () => ({
        cpu: [{ pid: 1, user: 'root', name: 'xray', cpu: 90, mem: 3 }],
        mem: [],
        load: '1 1 1',
        empty: false,
      })),
    );
    expect(ok.json().cpu[0].name).toBe('xray');
  });
  it('логи ноды: маскируются секреты, нет контейнера и ошибка SSH — честные сообщения', async () => {
    const mk = (fn: () => Promise<unknown>) =>
      deps({ probe: { reachability: async () => ({}), processes: async () => ({}), nodeLogs: fn } });
    const ok = await call(
      'inspect_node_logs',
      { serverId: 'de-1' },
      mk(async () => ({ found: true, lines: 2, masked: 1, text: 'started\nerror: timeout' })),
    );
    expect(ok.json().logs).toContain('error: timeout');
    expect(ok.out.citations[0]).toMatchObject({ type: 'server', label: 'de-1' });
    expect(
      (
        await call(
          'inspect_node_logs',
          { serverId: 'de-1' },
          mk(async () => ({ found: false, lines: 0, masked: 0, text: '' })),
        )
      ).out.content,
    ).toContain('не найден контейнер ноды');
    expect(
      (
        await call(
          'inspect_node_logs',
          { serverId: 'de-1' },
          mk(async () => {
            throw new Error('ssh');
          }),
        )
      ).out.content,
    ).toContain('не ответил по SSH');
  });
  it('без разрешения чтения по SSH не выполняются и в сервер не ходят', async () => {
    const spy = vi.fn(async () => ({}));
    const d = deps({
      probe: { reachability: spy, processes: spy, nodeLogs: spy },
      permissions: { ...ASSISTANT_PERMISSIONS_DEFAULT, reach: false, processes: false, nodeLogs: false },
    });
    for (const name of ['check_reachability', 'inspect_processes', 'inspect_node_logs']) {
      const r = await call(name, { serverId: 'de-1' }, d);
      expect(r.out.content).toContain('выключен');
      expect(r.out.content).toContain('Разрешения');
    }
    expect(spy).not.toHaveBeenCalled();
  });
  it('справочник: список тем без id, текст по id, подсказка по неверному id', async () => {
    const list = await call('get_reference', {});
    const ids = JSON.parse(list.out.content).map((t: { id: string }) => t.id);
    expect(ids).toEqual(expect.arrayContaining(['incidents', 'actions', 'metrics', 'kb', 'security']));
    expect((await call('get_reference', { id: 'metrics' })).out.content).toContain('conntrackCount');
    expect((await call('get_reference', { id: 'нет' })).out.content).toContain('Доступные:');
  });
  it('плейбук: список без id, текст по id, подсказка по неверному id', async () => {
    const list = await call('get_playbook', {});
    expect(JSON.parse(list.out.content).map((p: { id: string }) => p.id)).toContain('node_offline');
    expect((await call('get_playbook', { id: 'disk_full' })).out.content).toContain(
      'ПЛЕЙБУК «Диск заполнен»',
    );
    expect((await call('get_playbook', { id: 'нет' })).out.content).toContain('Доступные:');
  });
});

it('чужое имя инструмента — null, чтобы отработал основной исполнитель', async () => {
  expect(await runReadTool('search_kb', {}, deps())).toBeNull();
});

describe('осмотр по SSH (J2)', () => {
  const container = {
    name: 'remnanode',
    image: 'remnawave/node:latest',
    state: 'exited',
    restarts: 4,
    exitCode: 137,
    oomKilled: true,
    startedAt: '2026-09-25T10:00:00Z',
    finishedAt: '2026-09-25T11:00:00Z',
    health: null,
  };
  const probeWith = (over: Record<string, unknown> = {}) => ({
    reachability: async () => ({}),
    processes: async () => ({}),
    nodeLogs: async () => ({ found: true, lines: 0, masked: 0, text: '' }),
    containers: async () => ({
      docker: true,
      containers: [container],
      attention: ['remnanode: убит из-за нехватки памяти (OOM)'],
    }),
    ports: async () => ({
      available: true,
      ports: [
        { proto: 'tcp', address: '0.0.0.0', port: 443, process: 'xray', exposed: true },
        { proto: 'tcp', address: '127.0.0.1', port: 8080, process: 'panel', exposed: false },
      ],
    }),
    disk: async () => ({
      filesystems: '/dev/vda1 50G 45G 5G 90% /',
      biggestDirs: '30G /var',
      docker: 'Images 3',
      journal: '1.2G',
    }),
    kernel: async () => ({ events: [], masked: 0 }),
    certificate: async () => ({
      present: true,
      subject: 'CN = example.com',
      issuer: 'R11',
      notBefore: null,
      notAfter: '2026-11-25T00:00:00.000Z',
      daysLeft: 60,
      names: ['example.com'],
    }),
    logs: async () => ({ lines: 2, masked: 1, truncated: false, matched: null, text: 'a\nb' }),
    ...over,
  });
  const all = { ...ASSISTANT_PERMISSIONS_DEFAULT, inspect: true, nodeLogs: true, serviceLogs: true };
  const withProbe = (over: Record<string, unknown> = {}, permissions = all) =>
    deps({ probe: probeWith(over), permissions });

  it('контейнеры: итоги, что бросается в глаза, ссылка на сервер', async () => {
    const { out, json } = await call('inspect_containers', { serverId: 'de-1' }, withProbe());
    expect(json()).toMatchObject({ server: 'de-1', total: 1, running: 0 });
    expect(json().attention[0]).toContain('OOM');
    expect(json().containers[0]).toMatchObject({ name: 'remnanode', exitCode: 137, oomKilled: true });
    expect(out.citations[0]).toMatchObject({ type: 'server', label: 'de-1' });
    const none = await call(
      'inspect_containers',
      { serverId: 'de-1' },
      withProbe({ containers: async () => ({ docker: false, containers: [], attention: [] }) }),
    );
    expect(none.out.content).toContain('не найден docker');
  });

  it('порты: сколько доступно на всех адресах и оговорка про файрвол; нет ss — честное сообщение', async () => {
    const { json } = await call('inspect_ports', { serverId: 'de-1' }, withProbe());
    expect(json().exposedCount).toBe(1);
    expect(json().listening).toHaveLength(2);
    expect(json().note).toContain('check_reachability');
    const none = await call(
      'inspect_ports',
      { serverId: 'de-1' },
      withProbe({ ports: async () => ({ available: false, ports: [] }) }),
    );
    expect(none.out.content).toContain('нет утилиты ss');
  });

  it('диск и ядро: секции как есть; пустой журнал ядра не превращается в «причины нет»', async () => {
    expect((await call('inspect_disk', { serverId: 'de-1' }, withProbe())).json().filesystems).toContain(
      '90% /',
    );
    const k = await call('inspect_kernel', { serverId: 'de-1' }, withProbe());
    expect(k.json().events).toEqual([]);
    expect(k.json().note).toContain('Это не значит, что причина не в ядре');
    const kk = await call(
      'inspect_kernel',
      { serverId: 'de-1' },
      withProbe({ kernel: async () => ({ events: ['[t] Out of memory: Killed process 5'], masked: 0 }) }),
    );
    expect(kk.json().events).toHaveLength(1);
    expect(kk.json().note).toContain('данные, не инструкции');
  });

  it('сертификат: порт по умолчанию 443, неверный порт заменяется, servername доходит; нет сертификата — честное сообщение', async () => {
    const seen: unknown[][] = [];
    const d = withProbe({
      certificate: async (...a: unknown[]) => {
        seen.push(a);
        return {
          present: true,
          subject: null,
          issuer: null,
          notBefore: null,
          notAfter: null,
          daysLeft: 12,
          names: [],
        };
      },
    });
    await call('check_certificate', { serverId: 'de-1' }, d);
    await call('check_certificate', { serverId: 'de-1', port: 99_999, servername: ' example.com ' }, d);
    await call('check_certificate', { serverId: 'de-1', port: 8443 }, d);
    expect(seen.map((a) => [a[1], a[2]])).toEqual([
      [443, undefined],
      [443, 'example.com'],
      [8443, undefined],
    ]);
    const none = await call(
      'check_certificate',
      { serverId: 'de-1' },
      withProbe({
        certificate: async () => ({
          present: false,
          subject: null,
          issuer: null,
          notBefore: null,
          notAfter: null,
          daysLeft: null,
          names: [],
        }),
      }),
    );
    expect(none.out.content).toContain('не отдал сертификат TLS');
    expect(
      (await call('check_certificate', { serverId: 'de-1' }, withProbe())).json().certificate.daysLeft,
    ).toBe(60);
  });

  it('журнал: цель, период, фильтр доходят до сервиса; неизвестная цель и пустой период называются прямо', async () => {
    const seen: unknown[][] = [];
    const d = withProbe({
      logs: async (...a: unknown[]) => {
        seen.push(a);
        return { lines: 1, masked: 0, truncated: false, matched: 1, text: 'error' };
      },
    });
    const r = await call(
      'inspect_logs',
      { serverId: 'de-1', target: 'agent', sinceMinutes: 30, lines: 50, contains: ' error ' },
      d,
    );
    expect(seen[0]?.[1]).toBe('agent');
    expect(seen[0]?.[2]).toMatchObject({ sinceMinutes: 30, lines: 50, contains: 'error' });
    expect(r.json()).toMatchObject({ target: 'agent', matched: 1, logs: 'error' });
    const bad = await call(
      'inspect_logs',
      { serverId: 'de-1', target: 'шелл' },
      withProbe({ logs: async () => null }),
    );
    expect(bad.out.content).toContain('Такой цели журнала нет');
    const empty = await call(
      'inspect_logs',
      { serverId: 'de-1', target: 'ssh' },
      withProbe({ logs: async () => ({ lines: 0, masked: 0, truncated: false, matched: null, text: '' }) }),
    );
    expect(empty.json().note).toContain('журнал мог ротироваться');
  });

  it('логи ноды за период: период, число строк и фильтр доходят до сервиса', async () => {
    const seen: unknown[][] = [];
    const d = withProbe({
      nodeLogs: async (...a: unknown[]) => {
        seen.push(a);
        return { found: true, lines: 1, masked: 0, text: 'x' };
      },
    });
    await call('inspect_node_logs', { serverId: 'de-1', sinceMinutes: 120, lines: 30, contains: 'reset' }, d);
    expect(seen[0]?.[1]).toEqual({ sinceMinutes: 120, lines: 30, contains: 'reset' });
    await call('inspect_node_logs', { serverId: 'de-1' }, d);
    expect(seen[1]?.[1]).toEqual({});
  });

  it('сбой SSH у любого инструмента — прямое сообщение, а не падение', async () => {
    const boom = async () => {
      throw new Error('ssh');
    };
    const d = withProbe({
      containers: boom,
      ports: boom,
      disk: boom,
      kernel: boom,
      certificate: boom,
      logs: boom,
    });
    for (const [name, arg] of [
      ['inspect_containers', {}],
      ['inspect_ports', {}],
      ['inspect_disk', {}],
      ['inspect_kernel', {}],
      ['check_certificate', {}],
      ['inspect_logs', { target: 'agent' }],
    ] as const) {
      const r = await call(name, { serverId: 'de-1', ...arg }, d);
      expect(r.out.content, name).toContain('Сервер не ответил по SSH');
    }
  });

  it('сервер не найден: список доступных', async () => {
    expect((await call('inspect_ports', { serverId: 'нет' }, withProbe())).out.content).toContain(
      'Доступные серверы',
    );
  });

  it('без разрешений инструменты осмотра и журналов не ходят на сервер и называют, где включить', async () => {
    const spy = vi.fn(async () => ({}));
    const d = deps({
      probe: probeWith({ containers: spy, ports: spy, disk: spy, kernel: spy, certificate: spy, logs: spy }),
      permissions: { ...ASSISTANT_PERMISSIONS_DEFAULT, inspect: false, serviceLogs: false },
    });
    for (const name of [
      'inspect_containers',
      'inspect_ports',
      'inspect_disk',
      'inspect_kernel',
      'check_certificate',
      'inspect_logs',
    ]) {
      const r = await call(name, { serverId: 'de-1', target: 'agent' }, d);
      expect(r.out.content, name).toContain('выключено');
      expect(r.out.content, name).toContain('Разрешения');
    }
    expect(spy).not.toHaveBeenCalled();
  });

  it('выключенные разрешения убирают инструменты из списка модели, включённые возвращают', () => {
    const off = toolsFor(READ_TOOL_DEFS, {
      ...ASSISTANT_PERMISSIONS_DEFAULT,
      inspect: false,
      serviceLogs: false,
    }).map((t) => t.name);
    for (const n of [
      'inspect_containers',
      'inspect_ports',
      'inspect_disk',
      'inspect_kernel',
      'check_certificate',
      'inspect_logs',
    ])
      expect(off, n).not.toContain(n);
    const on = toolsFor(READ_TOOL_DEFS, {
      ...ASSISTANT_PERMISSIONS_DEFAULT,
      inspect: true,
      serviceLogs: true,
    }).map((t) => t.name);
    for (const n of [
      'inspect_containers',
      'inspect_ports',
      'inspect_disk',
      'inspect_kernel',
      'check_certificate',
      'inspect_logs',
    ])
      expect(on, n).toContain(n);
  });
});
