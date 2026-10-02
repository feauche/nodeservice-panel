import type { RemnawaveCert, RemnawaveNode, RemnawaveStats, RemnawaveStatus } from '@nodeservice/shared';
import { HttpResponse, http } from 'msw';

import { mockServers } from './servers-mock';

const CERT_OK: RemnawaveCert = {
  status: 'ok',
  expiresAt: '2026-11-21T00:00:00.000Z',
  daysLeft: 54,
  note: null,
};

const STATS: RemnawaveStats = {
  users: { total: 870, active: 812, disabled: 14, limited: 3, expired: 41 },
  online: { now: 236, lastDay: 512, lastWeek: 640, never: 28 },
  nodesOnline: 4,
  nodesTotal: 5,
  trafficBytesLifetime: '20239053209600',
  panelVersion: '3.4.4',
  panelUptimeSec: 361_440,
};

/** «bridge» совпадает по адресу с сервером de-fra-01 (203.0.113.7) — так пилюля C1 проверяется без ручного связывания. */
const NODES: RemnawaveNode[] = [
  {
    uuid: '0192f200-0000-7000-8000-000000000001',
    name: 'bridge',
    address: '203.0.113.7',
    countryCode: 'DE',
    isConnected: true,
    isDisabled: false,
    isConnecting: false,
    lastStatusMessage: null,
    usersOnline: 42,
    trafficUsedBytes: 1_200_000_000_000,
    trafficLimitBytes: null,
  },
  {
    uuid: '0192f200-0000-7000-8000-000000000002',
    name: 'exit-nl',
    address: '198.51.100.99',
    countryCode: 'NL',
    isConnected: false,
    isDisabled: false,
    isConnecting: false,
    lastStatusMessage: 'Node did not respond in time',
    // Как настоящий сервер: у включённой ноды без метрик онлайн — 0; пусто — только у выключенной вручную.
    usersOnline: 0,
    trafficUsedBytes: 300_000_000_000,
    trafficLimitBytes: 5_000_000_000_000,
  },
];

/** Состояние мока в памяти: тесты и скрипты снимков читают и меняют его напрямую. */
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

/**
 * Как на сервере: к каждой ноде — серверы панели, на которых она работает. Сначала выбор из профиля сервера,
 * затем совпадение адреса; «Нет ноды» связь снимает. (Сверку по IP за доменом мок не повторяет.)
 */
function withServers(nodes: RemnawaveNode[]): RemnawaveNode[] {
  const manual = new Set(mockServers.items.map((s) => s.nodeLink));
  const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
  return nodes.map((n) => {
    const chosen = mockServers.items.filter((s) => s.nodeLink === n.uuid);
    const found = manual.has(n.uuid)
      ? []
      : mockServers.items.filter((s) => s.nodeLink === 'auto' && same(s.host, n.address));
    const servers = [...chosen, ...found];
    return {
      ...n,
      serverIds: servers.map((s) => s.id),
      linkedBy: chosen.length > 0 ? 'manual' : found.length > 0 ? 'address' : null,
    };
  });
}

function status(): RemnawaveStatus {
  return {
    connected: mockRemnawave.connected,
    domain: mockRemnawave.domain,
    checkedAt: mockRemnawave.checkedAt,
    lastAttemptAt: mockRemnawave.lastAttemptAt,
    error: mockRemnawave.error,
    stats: mockRemnawave.stats,
    nodes: withServers(mockRemnawave.nodes),
    cert: mockRemnawave.cert,
  };
}

const problem = (status_: number, type: string, detail: string) =>
  HttpResponse.json(
    { type, title: detail, status: status_, detail },
    { status: status_, headers: { 'content-type': 'application/problem+json' } },
  );

function connectNow(): void {
  const now = new Date().toISOString();
  Object.assign(mockRemnawave, {
    connected: true,
    checkedAt: now,
    lastAttemptAt: now,
    error: null,
    stats: STATS,
    nodes: NODES,
    cert: CERT_OK,
  });
}

export const remnawaveHandlers = [
  http.get('/api/remnawave/status', () => HttpResponse.json(status())),
  http.post('/api/remnawave/connect', async ({ request }) => {
    const body = (await request.json()) as { domain?: string; apiKey?: string };
    const domain = (body.domain ?? '').replace(/^https?:\/\//i, '').replace(/\/+$/, '');
    if (!domain || !body.apiKey)
      return HttpResponse.json(
        {
          type: 'about:blank',
          title: 'Проверьте поля',
          status: 422,
          errors: [{ path: 'domain', message: 'Обязательное поле' }],
        },
        { status: 422 },
      );
    if (domain === 'unreachable.example.com')
      return problem(
        502,
        'urn:nodeservice:problem:remnawave-domain-unreachable',
        `Remnawave (https://${domain}) не отвечает: сетевая ошибка.`,
      );
    if (body.apiKey === 'rw_pat_bad')
      return problem(
        400,
        'urn:nodeservice:problem:remnawave-unauthorized',
        'Remnawave ответила «доступ запрещён»: токен неверный, отозван или просрочен.',
      );
    mockRemnawave.domain = domain;
    connectNow();
    return HttpResponse.json(status());
  }),
  http.post('/api/remnawave/refresh', () => {
    if (!mockRemnawave.connected)
      return problem(409, 'urn:nodeservice:problem:remnawave-not-connected', 'Remnawave не подключена.');
    connectNow();
    return HttpResponse.json(status());
  }),
  http.delete('/api/remnawave', () => {
    seedRemnawave();
    return new HttpResponse(null, { status: 204 });
  }),
];
