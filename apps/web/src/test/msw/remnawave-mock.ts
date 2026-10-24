import {
  NODE_MAINTENANCE_EXTEND_MINUTES,
  type NodeMaintenance,
  type NodeReserve,
  nodeMaintenanceStartSchema,
  type RemnawaveCert,
  type RemnawaveNode,
  type RemnawaveStats,
  type ScenarioDisabledHosts,
} from '@nodeservice/shared';
import { HttpResponse, http } from 'msw';

/**
 * Состояние подключения Remnawave для тестов: его отдают подменённые ответы `/api/nodes/status`
 * (тесты «Обзора» и Ассистента). Тесты и скрипты снимков читают и меняют его напрямую.
 */
export const mockRemnawave: {
  connected: boolean;
  domain: string | null;
  checkedAt: string | null;
  lastAttemptAt: string | null;
  error: string | null;
  stats: RemnawaveStats | null;
  nodes: RemnawaveNode[];
  cert: RemnawaveCert | null;
} = {
  connected: false,
  domain: null,
  checkedAt: null,
  lastAttemptAt: null,
  error: null,
  stats: null,
  nodes: [],
  cert: null,
};

// Режим VITE_MOCK=1: управление из скриншот-сценариев.
if (typeof window !== 'undefined')
  (window as unknown as { __nsMockRemnawave: typeof mockRemnawave }).__nsMockRemnawave = mockRemnawave;

/** Host, отключённые сценариями (0.108.0): метка «Host отключён» и блок с возвратом в окне ноды. */
export const mockDisabledHosts: ScenarioDisabledHosts = { items: [] };
/** Ноды с «Лимитом канала» (0.110.0): «Какие ноды проверяются» у «Следить за каналом». */
export const mockChannelLimits = new Set<string>();
/** Запасные IP нод (0.111.0): нода → список; переключение меняет адрес ноды в mockRemnawave. */
export const mockReserve: Record<string, NodeReserve> = {};
const reserveOf = (uuid: string): NodeReserve => {
  mockReserve[uuid] ??= { items: [], auto: false, lastSwitch: null };
  return mockReserve[uuid];
};

export function seedRemnawave(): void {
  for (const key of Object.keys(mockMaintenanceHosts)) delete mockMaintenanceHosts[key];
  mockDisabledHosts.items = [];
  mockChannelLimits.clear();
  for (const key of Object.keys(mockReserve)) delete mockReserve[key];
  Object.assign(mockRemnawave, {
    connected: false,
    domain: null,
    checkedAt: null,
    lastAttemptAt: null,
    error: null,
    stats: null,
    nodes: [],
    cert: null,
  });
}

/** Host нод в учебной Remnawave — для окна «Обслуживание» (какие скроются). */
export const mockMaintenanceHosts: Record<
  string,
  {
    hosts: Array<{ uuid: string; name: string; address: string; port: number | null }>;
    shared: number;
    alreadyHidden: number;
  }
> = {};

/** Обслуживание нод (0.106.0): включить, продлить, закончить — меняет ноду в mockRemnawave. */
export const maintenanceHandlers = [
  http.get('/api/nodes/:uuid/reserve', ({ params }) => HttpResponse.json(reserveOf(String(params.uuid)))),
  http.post('/api/nodes/:uuid/reserve', async ({ params, request }) => {
    const { ip } = (await request.json()) as { ip: string };
    const r = reserveOf(String(params.uuid));
    r.items.push({
      ip: ip.trim(),
      wasPrimaryUntil: null,
      check: {
        at: new Date().toISOString(),
        ok: true,
        verdict: 'reachable',
        text: 'Отвечает · из РФ 9 из 9, из других стран 6 из 6',
      },
    });
    return HttpResponse.json(r);
  }),
  http.post('/api/nodes/:uuid/reserve/:ip/check', ({ params }) =>
    HttpResponse.json(reserveOf(String(params.uuid))),
  ),
  http.delete('/api/nodes/:uuid/reserve/:ip', ({ params }) => {
    const r = reserveOf(String(params.uuid));
    r.items = r.items.filter((i) => i.ip !== String(params.ip));
    return HttpResponse.json(r);
  }),
  http.put('/api/nodes/:uuid/reserve/auto', async ({ params, request }) => {
    const r = reserveOf(String(params.uuid));
    r.auto = ((await request.json()) as { auto: boolean }).auto;
    return HttpResponse.json(r);
  }),
  http.put('/api/nodes/:uuid/reserve/order', async ({ params, request }) => {
    const r = reserveOf(String(params.uuid));
    const { ips } = (await request.json()) as { ips: string[] };
    r.items = ips.map((ip) => r.items.find((i) => i.ip === ip)).filter((i) => i !== undefined);
    return HttpResponse.json(r);
  }),
  http.get('/api/nodes/:uuid/reserve/plan', ({ params, request }) => {
    const node = mockRemnawave.nodes.find((n) => n.uuid === params.uuid);
    const to = new URL(request.url).searchParams.get('to') ?? '';
    const from = node?.address ?? '';
    return HttpResponse.json({
      from,
      to,
      blocked: null,
      dnsNote: null,
      steps: [
        { kind: 'node', title: 'Адрес ноды в Remnawave', detail: `${from} → ${to}`, ok: null, error: null },
        {
          kind: 'dns',
          title: 'de.example.com · Cloudflare',
          detail: `A ${from} → ${to}`,
          ok: null,
          error: null,
        },
      ],
    });
  }),
  http.post('/api/nodes/:uuid/reserve/switch', async ({ params, request }) => {
    const { to } = (await request.json()) as { to: string };
    const node = mockRemnawave.nodes.find((n) => n.uuid === params.uuid);
    const from = node?.address ?? '';
    if (node) node.address = to;
    const r = reserveOf(String(params.uuid));
    const at = new Date().toISOString();
    r.items = [...r.items.filter((i) => i.ip !== to), { ip: from, check: null, wasPrimaryUntil: at }];
    r.lastSwitch = { at, from, to, by: 'manual' };
    return HttpResponse.json({
      nodeName: node?.name ?? '',
      reserve: r,
      plan: {
        from,
        to,
        blocked: null,
        dnsNote: null,
        steps: [
          { kind: 'node', title: 'Адрес ноды в Remnawave', detail: `${from} → ${to}`, ok: true, error: null },
          {
            kind: 'dns',
            title: 'de.example.com · Cloudflare',
            detail: `A ${from} → ${to}`,
            ok: true,
            error: null,
          },
        ],
      },
    });
  }),
  http.get('/api/nodes/channel-coverage', () => {
    const nodes = mockRemnawave.nodes.filter((n) => !n.isDisabled);
    const missing = nodes
      .filter((n) => !mockChannelLimits.has(n.uuid))
      .map((n) => ({ uuid: n.uuid, name: n.name }));
    return HttpResponse.json({ total: nodes.length, withLimit: nodes.length - missing.length, missing });
  }),
  http.get('/api/scenarios/disabled', () => HttpResponse.json(mockDisabledHosts)),
  http.post('/api/scenarios/disabled/:uuid/restore', ({ params }) => {
    const item = mockDisabledHosts.items.find((i) => i.nodeUuid === params.uuid);
    mockDisabledHosts.items = mockDisabledHosts.items.filter((i) => i.nodeUuid !== params.uuid);
    return HttpResponse.json({ restored: item?.hosts.map((h) => h.name ?? 'Host') ?? [], failed: [] });
  }),
  http.get('/api/nodes/:uuid/maintenance/hosts', ({ params }) =>
    HttpResponse.json(
      mockMaintenanceHosts[String(params.uuid)] ?? { hosts: [], shared: 0, alreadyHidden: 0 },
    ),
  ),
  http.put('/api/nodes/:uuid/maintenance', async ({ params, request }) => {
    const node = mockRemnawave.nodes.find((n) => n.uuid === params.uuid);
    if (!node) return HttpResponse.json({ detail: 'Нода не найдена в Remnawave.' }, { status: 404 });
    const body = nodeMaintenanceStartSchema.parse(await request.json());
    const now = Date.now();
    const hidden = body.hideHosts ? (mockMaintenanceHosts[node.uuid]?.hosts ?? []).map((h) => h.name) : [];
    const m: NodeMaintenance = {
      nodeUuid: node.uuid,
      nodeName: node.name,
      startedAt: new Date(now).toISOString(),
      until: body.minutes === null ? null : new Date(now + body.minutes * 60_000).toISOString(),
      reason: body.reason,
      hideHosts: body.hideHosts,
      hosts: body.hideHosts ? { hidden, shared: 0, error: null } : null,
    };
    node.maintenance = m;
    return HttpResponse.json(m);
  }),
  http.post('/api/nodes/:uuid/maintenance/extend', ({ params }) => {
    const node = mockRemnawave.nodes.find((n) => n.uuid === params.uuid);
    const m = node?.maintenance;
    if (!node || !m) return HttpResponse.json({ detail: 'Обслуживание этой ноды не идёт.' }, { status: 404 });
    const until =
      m.until === null
        ? null
        : new Date(
            Math.max(Date.parse(m.until), Date.now()) + NODE_MAINTENANCE_EXTEND_MINUTES * 60_000,
          ).toISOString();
    node.maintenance = { ...m, until };
    return HttpResponse.json(node.maintenance);
  }),
  http.delete('/api/nodes/:uuid/maintenance', ({ params }) => {
    const node = mockRemnawave.nodes.find((n) => n.uuid === params.uuid);
    const m = node?.maintenance;
    if (!node || !m) return HttpResponse.json({ detail: 'Обслуживание этой ноды не идёт.' }, { status: 404 });
    node.maintenance = null;
    return HttpResponse.json({ ended: m, restored: m.hosts?.hidden ?? [], failed: [] });
  }),
];
