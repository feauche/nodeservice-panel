import {
  NODE_MAINTENANCE_EXTEND_MINUTES,
  type NodeMaintenance,
  nodeMaintenanceStartSchema,
  type RemnawaveCert,
  type RemnawaveNode,
  type RemnawaveStats,
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

export function seedRemnawave(): void {
  for (const key of Object.keys(mockMaintenanceHosts)) delete mockMaintenanceHosts[key];
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
