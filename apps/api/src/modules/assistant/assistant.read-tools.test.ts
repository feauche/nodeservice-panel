import {
  ASSISTANT_PERMISSIONS_DEFAULT,
  DEFAULT_SERVER_COUNTRY,
  type Incident,
  type Server,
} from '@nodeservice/shared';
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
    country: { ...DEFAULT_SERVER_COUNTRY },
    profile: {
      roles: [],
      importance: 'normal',
      maintenanceWindow: null,
      expectedContainers: [],
      expectedPorts: [],
    },
    inventory: null,
    drift: [],
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
    checks: {
      list: async () => ({
        autoEnabled: true,
        nextAutoAt: '2026-09-29T10:00:00.000Z',
        items: [
          {
            id: '0199a0b0-0000-7000-8000-000000000001',
            serverId: ID_A,
            check: 'geoblock',
            status: 'ok',
            trigger: 'auto',
            actorDisplay: null,
            startedAt: '2026-09-28T10:00:00.000Z',
            finishedAt: '2026-09-28T10:02:00.000Z',
            output: `${'шапка\n'.repeat(4000)}ChatGPT: заблокирован по региону`,
            error: null,
          },
        ],
      }),
      history: async () => [],
      startForJarvis: async (serverId: string, check: string) => ({ id: 'run-1', serverId, check }),
      waitDone: async () => ({
        id: 'run-1',
        status: 'ok',
        error: null,
        output: 'Total: 0 blocked of 38',
        startedAt: '2026-09-28T12:00:00.000Z',
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

describe('get_server_checks', () => {
  it('отдаёт последний вывод проверок с понятным названием, конец длинного вывода сохраняется', async () => {
    const { json } = await call('get_server_checks', { serverId: 'de-1' });
    const r = json();
    expect(r.checks[0].check).toBe('Геоблок');
    expect(r.checks[0].output).toContain('ChatGPT: заблокирован по региону');
    expect(r.checks[0].output.length).toBeLessThan(13_000);
    expect(r.notRunYet).toContain('Процессор');
    expect(r.notRunYet).not.toContain('Геоблок');
  });
  it('говорит, включён ли суточный замер: пустой срок без этого не отличить от «ещё не запускался»', async () => {
    const d = deps();
    const base = await d.checks.list('');
    const off = deps({
      checks: { ...d.checks, list: async () => ({ ...base, autoEnabled: false, nextAutoAt: null }) },
    });
    const r = (await call('get_server_checks', { serverId: 'de-1' }, off)).json();
    expect(r).toMatchObject({ autoEnabled: false, nextAutoAt: null });
  });
});

describe('run_server_check', () => {
  it('лёгкую запускает и отдаёт свежий вывод', async () => {
    const { json } = await call('run_server_check', { serverId: 'de-1', check: 'geoblock' });
    expect(json()).toMatchObject({ check: 'Геоблок', ranJustNow: true, status: 'ok' });
    expect(json().output).toContain('0 blocked');
  });
  it('живая строка: «идёт» в начале, «готова» в конце; та же строка — в ответе', async () => {
    const seen: Array<{ state: string; label: string }> = [];
    const d = deps({ progress: (a: { state: string; label: string }) => seen.push(a) });
    const { out } = await call('run_server_check', { serverId: 'de-1', check: 'geoblock' }, d);
    expect(seen.map((x) => x.state)).toEqual(['running', 'done']);
    expect(seen[0]?.label).toBe('Проверка «Геоблок» на «de-1»');
    expect(out.activity?.[0]).toMatchObject({
      state: 'done',
      detail: 'Вывод — во вкладке «Проверки» сервера.',
    });
  });
  it('тяжёлую не запускает — отсылает к карточке', async () => {
    const { out } = await call('run_server_check', { serverId: 'de-1', check: 'yabs' });
    expect(out.content).toContain('propose_change server.check');
  });
  it('без разрешения — отказ с подсказкой, где включить', async () => {
    const d = deps({ permissions: { ...ASSISTANT_PERMISSIONS_DEFAULT, checksRun: false } });
    const { out } = await call('run_server_check', { serverId: 'de-1', check: 'cpu' }, d);
    expect(out.content).toContain('Настройки → Джарвис → Разрешения');
  });
  it('автоматический разбор (администратора рядом нет): сторонний скрипт не запускает, свою проверку — да', async () => {
    const started: string[] = [];
    const checks = {
      ...(deps().checks as object),
      startForJarvis: async (serverId: string, check: string) => {
        started.push(check);
        return { id: 'run-1', serverId, check };
      },
    };
    const d = deps({ unattended: true, checks });
    for (const check of ['ip_region', 'geoblock', 'dpi', 'ip_quality']) {
      const { out } = await call('run_server_check', { serverId: 'de-1', check }, d);
      expect(out.content, check).toContain('сторонний скрипт');
      expect(out.content, check).toContain('get_server_checks');
    }
    expect(started).toEqual([]);
    expect((await call('run_server_check', { serverId: 'de-1', check: 'cpu' }, d)).json()).toMatchObject({
      check: 'Процессор',
      ranJustNow: true,
    });
    expect(started).toEqual(['cpu']);
    // В чате, по вопросу администратора, — как раньше.
    await call('run_server_check', { serverId: 'de-1', check: 'ip_quality' }, deps({ checks }));
    expect(started).toEqual(['cpu', 'ip_quality']);
    // Модель знает правило заранее и не тратит на отказ ход.
    const def = READ_TOOL_DEFS.find((t) => t.name === 'run_server_check');
    expect(def?.description).toContain('В автоматическом разборе');
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
      dockerRunning: true,
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
      withProbe({
        containers: async () => ({
          docker: false,
          dockerRunning: false,
          containers: [],
          attention: [],
        }),
      }),
    );
    expect(none.out.content).toContain('не найден docker');
    const down = await call(
      'inspect_containers',
      { serverId: 'de-1' },
      withProbe({
        containers: async () => ({
          docker: true,
          dockerRunning: false,
          containers: [],
          attention: [],
        }),
      }),
    );
    expect(down.out.content).toContain('служба не отвечает');
    expect(down.out.content).toContain('нельзя утверждать');
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

describe('профиль сервера в инструментах', () => {
  const profiled = server({
    profile: {
      roles: ['entry', 'exit'],
      importance: 'critical',
      maintenanceWindow: 'ночью по Москве',
      expectedContainers: ['remnanode'],
      expectedPorts: [443],
    },
    inventory: {
      at: new Date(Date.now() - 5 * 3_600_000).toISOString(),
      docker: true,
      containers: [{ name: 'remnanode', state: 'exited', restarts: 3 }],
      ports: [],
    },
    drift: [
      {
        kind: 'container_not_running',
        subject: 'remnanode',
        detail: 'Контейнер «remnanode» не работает (состояние: exited).',
      },
      { kind: 'port_not_listening', subject: '443', detail: 'Порт 443 никто не слушает.' },
    ],
  });
  const d = () => deps({ servers: { list: async () => [profiled, server({ id: ID_B, name: 'nl-2' })] } });

  it('сводка парка: функции и важность словами, расхождения, сколько профилей заполнено', async () => {
    const { json } = await call('get_fleet_status', {}, d());
    expect(json().totals).toMatchObject({ profilesFilled: 1, withDrift: 1 });
    const row = json().servers.find((x: { name: string }) => x.name === 'de-1');
    expect(row.profile).toMatchObject({
      roles: ['Принимает подключения клиентов', 'Выпускает трафик в интернет'],
      importance: 'Критичный',
      profileFilled: true,
    });
    expect(row.profile.drift).toHaveLength(2);
    const other = json().servers.find((x: { name: string }) => x.name === 'nl-2');
    expect(other.profile).toMatchObject({
      roles: [],
      importance: 'Обычный',
      profileFilled: false,
      drift: [],
    });
  });
  it('сервер: профиль, возраст снимка и сам снимок с оговоркой про свежие данные', async () => {
    const { json } = await call('get_server_detail', { serverId: 'de-1' }, d());
    expect(json().profile).toMatchObject({
      roles: ['Принимает подключения клиентов', 'Выпускает трафик в интернет'],
      maintenanceWindow: 'ночью по Москве',
      expected: { containers: ['remnanode'], ports: [443] },
      snapshotAgeHours: 5,
    });
    expect(json().snapshot.containers[0]).toMatchObject({ name: 'remnanode', state: 'exited' });
    expect(json().snapshot.note).toContain('inspect_containers');
    const none = await call('get_server_detail', { serverId: 'nl-2' }, d());
    expect(none.json().snapshot).toBeNull();
    expect(none.json().profile.snapshotAgeHours).toBeNull();
  });
});

describe('страна сервера в инструментах', () => {
  const withCountry = (country: Partial<Server['country']>) =>
    server({ country: { ...DEFAULT_SERVER_COUNTRY, ...country } });
  const d = (list: Server[]) => deps({ servers: { list: async () => list } });

  it('определена автоматически: название, режим, сколько источников согласились', async () => {
    const s = withCountry({
      code: 'PL',
      source: 'auto',
      status: 'ok',
      agree: 5,
      total: 7,
      checkedAt: '2026-09-26T10:00:00.000Z',
    });
    const { json } = await call('get_server_detail', { serverId: 'de-1' }, d([s]));
    expect(json().country).toEqual({
      code: 'PL',
      name: 'Польша',
      mode: 'определяется автоматически по IP',
      status: 'определена',
      sources: '5 из 7',
      checkedAt: '2026-09-26T10:00:00.000Z',
      note: null,
    });
  });

  it('выбрана вручную: без числа источников; в сводке парка она тоже есть', async () => {
    const s = withCountry({ code: 'NL', source: 'manual', status: 'ok' });
    const fleet = (await call('get_fleet_status', {}, d([s]))).json();
    expect(fleet.servers[0].country).toMatchObject({
      code: 'NL',
      name: 'Нидерланды',
      mode: 'выбрана вручную',
    });
    expect(fleet.servers[0].country).not.toHaveProperty('sources');
  });

  it('не задана: null; идёт определение и не удалось: состояние и причина видны', async () => {
    expect((await call('get_server_detail', { serverId: 'de-1' }, d([server()]))).json().country).toBeNull();
    const detecting = withCountry({ status: 'detecting' });
    expect(
      (await call('get_server_detail', { serverId: 'de-1' }, d([detecting]))).json().country,
    ).toMatchObject({ code: null, status: 'идёт определение' });
    const failed = withCountry({ status: 'failed', note: 'Ответили только 2 источников из необходимых 4.' });
    expect((await call('get_server_detail', { serverId: 'de-1' }, d([failed]))).json().country).toMatchObject(
      { status: 'не удалось определить', note: expect.stringContaining('Ответили только 2') },
    );
  });
});

describe('get_capacity', () => {
  it('отдаёт ёмкость по нодам; без расчёта — честно «недоступна»', async () => {
    const capacity = {
      forAssistant: async () => ({
        fleet: { left: 1350, bottleneck: 'net' },
        servers: [{ name: 'Германия-1', left: 60 }],
      }),
    };
    const { json } = await call('get_capacity', {}, deps({ capacity }));
    expect(json()).toMatchObject({
      fleet: { left: 1350, bottleneck: 'net' },
      servers: [{ name: 'Германия-1', left: 60 }],
    });
    const { out } = await call('get_capacity', {}, deps({}));
    expect(out.content).toMatch(/недоступна/);
  });
});

describe('get_billing', () => {
  it('без биллинга — понятный ответ; с сервером — только его оплаты', async () => {
    const { out } = await call('get_billing', {});
    expect(out.content).toBe('Биллинг сейчас недоступен.');
    let seen: unknown = null;
    const billing = {
      forAssistant: async (o: unknown) => {
        seen = o;
        return {
          items: [{ title: 'DE-1', state: 'overdue', due: 'просрочено на 1 день' }],
          month: { spent: '0 ₽', expected: '468 ₽', payments: 0 },
          year: { spent: '0 ₽' },
          rates: null,
        };
      },
    };
    const { json } = await call('get_billing', { serverId: 'de-1' }, deps({ billing }));
    expect(seen).toEqual({ archived: false, serverId: ID_A });
    expect(json().items[0].due).toBe('просрочено на 1 день');
  });
});

describe('check_reachability: вход и любой адрес', () => {
  it('entry: true берёт вход из профиля, from — стучаться с самого выхода; address — любой домен', async () => {
    const seen: unknown[] = [];
    const exit = server({
      profile: {
        ...server({}).profile,
        roles: ['exit'],
        upstream: { kind: 'rent', serverId: null, address: 'amwey.guardora.pro:1819', owner: 'guardora' },
      },
    });
    const d = deps({
      servers: { list: async () => [exit, server({ id: ID_B, name: 'de-2', host: '10.0.0.2' })] },
      probe: {
        reachability: async () => ({}),
        reachabilityAddress: async (t: unknown, _all: unknown, ports: unknown, from: unknown) => {
          seen.push(t, ports, from);
          return {
            target: { name: 'x', address: 'x' },
            probes: [],
            ports: [],
            dns: { answers: [], consistent: true },
            notes: [],
          };
        },
        processes: async () => ({ cpu: [], mem: [], load: null, empty: true }),
      },
    });
    await call('check_reachability', { serverId: 'de-1', entry: true, from: 'de-1' }, d);
    expect(seen[0]).toMatchObject({ host: 'amwey.guardora.pro', port: 1819 });
    expect((seen[2] as Array<{ name: string }>)[0]?.name).toBe('de-1');
    seen.length = 0;
    await call('check_reachability', { address: 'https://example.com:8443/path' }, d);
    expect(seen[0]).toMatchObject({ host: 'example.com', port: 8443 });
    expect(seen[2]).toBeNull();
    const noEntry = await call('check_reachability', { serverId: 'de-2', entry: true }, d);
    expect(noEntry.out.content).toContain('не указано, откуда приходит трафик');
  });

  it('вход — свой мост: стучимся в порт его ноды, а не в SSH, и не с самого моста и не с выхода', async () => {
    const seen: unknown[] = [];
    const bridge = server({ id: ID_B, name: 'Мост', host: '10.0.0.2', port: 22 });
    const exit = server({
      profile: {
        ...server({}).profile,
        roles: ['exit'],
        upstream: { kind: 'bridge', serverId: ID_B, address: null, owner: null },
      },
    });
    const probe = {
      reachability: async () => ({}),
      reachabilityAddress: async (
        t: unknown,
        _all: unknown,
        _p: unknown,
        from: unknown,
        exclude: unknown,
      ) => {
        seen.push(t, from, exclude);
        return {
          target: { name: 'x', address: 'x' },
          probes: [],
          ports: [],
          dns: { answers: [], consistent: true },
          notes: [],
        };
      },
      processes: async () => ({ cpu: [], mem: [], load: null, empty: true }),
    };
    const known = deps({
      servers: { list: async () => [exit, bridge] },
      probe,
      // Порт ноды моста панель знает из Remnawave.
      upstreamTarget: async () => ({
        label: 'Мост «Мост»',
        host: '10.0.0.2',
        port: 8443,
        owner: null,
        serverId: ID_B,
        rented: false,
      }),
    });
    await call('check_reachability', { serverId: 'de-1', entry: true }, known);
    expect(seen[0]).toMatchObject({ host: '10.0.0.2', port: 8443 });
    expect(seen[1]).toBeNull();
    expect((seen[2] as string[]).sort()).toEqual([ID_A, ID_B].sort());

    // Порт ноды моста неизвестен — честный ответ, а не проверка порта SSH под видом входа.
    seen.length = 0;
    const blind = deps({
      servers: { list: async () => [exit, bridge] },
      probe,
      upstreamTarget: async () => null,
    });
    const r = await call('check_reachability', { serverId: 'de-1', entry: true }, blind);
    expect(seen).toEqual([]);
    expect(r.out.content).toContain('Порт входа у моста «Мост» панель не знает');
    expect(r.out.content).toContain('порт SSH');
  });
});
