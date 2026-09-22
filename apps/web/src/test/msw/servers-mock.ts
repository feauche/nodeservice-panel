import {
  AUTH_PROBLEM,
  createServerRequestSchema,
  SERVER_PROBLEM,
  type Server,
  type ServerFacts,
  updateServerRequestSchema,
} from '@nodeservice/shared';
import { HttpResponse, http } from 'msw';

import { stripAnsi } from '@/lib/strip-ansi';
import { seedMaintenance } from './maintenance-mock';

/** Мок /api/servers: состояние в памяти, SSH имитируется флагами. */
export const MOCK_SSH = {
  password: 'root-password',
  fingerprint: 'SHA256:mockfingerprintAAAA1111',
  newFingerprint: 'SHA256:mockfingerprintBBBB2222',
} as const;

const FACTS: ServerFacts = {
  hostname: 'node-1',
  os: 'Ubuntu',
  osVersion: '24.04',
  arch: 'x86_64',
  kernel: '6.8.0',
  cpuCores: 4,
  memoryMb: 8192,
};

interface ServersMock {
  items: Server[];
  /** Следующая проверка: сервер «переустановлен» — отпечаток другой. */
  hostKeyChanged: boolean;
  /** Следующее подключение падает по сети. */
  unreachable: boolean;
}

export const mockServers: ServersMock = { items: [], hostKeyChanged: false, unreachable: false };

let seq = 0;
function makeServer(patch: Partial<Server>): Server {
  seq += 1;
  return {
    id: `0192c000-0000-7000-8000-${String(seq).padStart(12, '0')}`,
    name: `srv-${seq}`,
    host: '203.0.113.7',
    port: 22,
    sshUser: 'root',
    authMethod: 'panel-key',
    tags: [],
    notes: null,
    facts: { ...FACTS },
    hostKeyFingerprint: MOCK_SSH.fingerprint,
    agentStatus: 'not_installed',
    agentVersion: null,
    agentLastSeenAt: null,
    sshOk: true,
    lastSshCheckAt: new Date().toISOString(),
    lastSshOkAt: new Date().toISOString(),
    createdAt: '2026-08-20T10:00:00.000Z',
    updatedAt: '2026-08-20T10:00:00.000Z',
    ...patch,
  };
}

/* ---------- история терминала ---------- */
export const mockTerminalSessions: {
  items: Array<{
    id: string;
    serverId: string;
    actorDisplay: string | null;
    startedAt: string;
    endedAt: string | null;
    cols: number;
    rows: number;
    bytesOut: number;
    truncated: boolean;
    exitCode: number | null;
    endReason: string | null;
  }>;
  transcripts: Record<string, string>;
} = { items: [], transcripts: {} };

export function seedTerminalSessions(serverId: string): void {
  const id = '22222222-2222-4222-8222-222222222222';
  mockTerminalSessions.items = [
    {
      id,
      serverId,
      actorDisplay: 'admin',
      startedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
      endedAt: new Date(Date.now() - 4 * 60_000).toISOString(),
      cols: 120,
      rows: 30,
      bytesOut: 1840,
      truncated: false,
      exitCode: 0,
      endReason: 'закрыт пользователем',
    },
  ];
  mockTerminalSessions.transcripts = {
    [id]: '\u001b[32mroot@de-fra-01\u001b[0m:~# nodectl status\r\nUFW: active\r\nFail2Ban: active\r\nroot@de-fra-01:~# ',
  };
}

export function seedServers(): void {
  seq = 0;
  mockServers.hostKeyChanged = false;
  mockServers.unreachable = false;
  mockServers.items = [
    makeServer({
      name: 'de-fra-01',
      tags: ['prod', 'de'],
      agentStatus: 'online',
      agentVersion: '0.5.4',
      agentLastSeenAt: new Date().toISOString(),
    }),
    makeServer({
      name: 'nl-ams-02',
      host: '198.51.100.20',
      tags: ['prod'],
      sshOk: false,
      facts: { ...FACTS, hostname: 'node-2', os: 'Debian', osVersion: '13', arch: 'aarch64' },
    }),
  ];
  seedTerminalSessions(mockServers.items[0]?.id ?? '');
  seedMaintenance(mockServers.items[0]?.id ?? '');
}
seedServers();

function problem(status: number, type: string, detail: string, extra: Record<string, unknown> = {}) {
  return HttpResponse.json(
    { type, title: detail, status, detail, ...extra },
    { status, headers: { 'content-type': 'application/problem+json' } },
  );
}

import { mockSecurity } from './security-mock';

/** Реальный API требует свежий step-up на удаление/доверие/токен — мок ведёт себя так же. */
const requireStepUp = () =>
  mockSecurity.stepUpFresh ? null : problem(403, AUTH_PROBLEM.stepUp, 'Подтверди пароль, чтобы продолжить');

const badAuth = (body: { auth?: { method?: string; password?: string } }): boolean =>
  body.auth?.method === 'password' && body.auth.password !== MOCK_SSH.password;

export const serversHandlers = [
  http.get('/api/servers', () => HttpResponse.json({ items: mockServers.items })),
  http.get('/api/servers/panel-key', () =>
    HttpResponse.json({ publicKey: 'ssh-ed25519 AAAAmockkey nodeservice-panel' }),
  ),
  http.get('/api/servers/:id', ({ params }) => {
    const s = mockServers.items.find((x) => x.id === params.id);
    return s ? HttpResponse.json(s) : problem(404, 'about:blank', 'Сервер не найден');
  }),
  http.post('/api/servers/test', async ({ request }) => {
    const body = (await request.json()) as { auth?: { method?: string; password?: string } };
    if (mockServers.unreachable)
      return problem(502, SERVER_PROBLEM.sshUnreachable, 'Не удалось подключиться по SSH.');
    if (badAuth(body)) return problem(400, SERVER_PROBLEM.sshAuth, 'Пароль или ключ не подошли.');
    return HttpResponse.json({ hostKeyFingerprint: MOCK_SSH.fingerprint, facts: FACTS });
  }),
  http.post('/api/servers', async ({ request }) => {
    const parsed = createServerRequestSchema.safeParse(await request.json());
    if (!parsed.success) return problem(400, 'about:blank', 'Данные не прошли проверку');
    const req = parsed.data;
    if (!req.verify && req.auth.method === 'password')
      return HttpResponse.json(
        {
          type: 'about:blank',
          title: 'Неверный запрос',
          status: 400,
          detail: 'С паролем сервер добавляется только с подключением.',
          errors: [{ path: 'password', message: 'С паролем подключение обязательно' }],
        },
        { status: 400 },
      );
    if (req.verify && badAuth(req))
      return problem(400, SERVER_PROBLEM.sshAuth, 'Пароль или ключ не подошли.');
    if (mockServers.items.some((s) => s.name === req.name))
      return HttpResponse.json(
        {
          type: SERVER_PROBLEM.nameTaken,
          title: 'Занято',
          status: 409,
          detail: 'Название уже занято',
          errors: [{ path: 'name', message: 'Название уже занято' }],
        },
        { status: 409 },
      );
    const server = makeServer({
      name: req.name,
      host: req.host,
      port: req.port,
      sshUser: req.sshUser,
      tags: req.tags,
      ...(req.verify
        ? {}
        : {
            facts: {
              hostname: null,
              os: null,
              osVersion: null,
              arch: null,
              kernel: null,
              cpuCores: null,
              memoryMb: null,
            },
            hostKeyFingerprint: null,
            sshOk: null,
            lastSshCheckAt: null,
            lastSshOkAt: null,
          }),
    });
    mockServers.items = [...mockServers.items, server];
    return HttpResponse.json(server, { status: 201 });
  }),
  http.post('/api/servers/:id/duplicate', ({ params }) => {
    const src = mockServers.items.find((x) => x.id === params.id);
    if (!src) return problem(404, 'about:blank', 'Сервер не найден');
    const base = src.name.replace(/-[1-9]\d*$/, '');
    const esc = base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    let max = 1;
    for (const s of mockServers.items) {
      const m = s.name.match(new RegExp(`^${esc}-([1-9]\\d*)$`));
      if (m?.[1]) max = Math.max(max, Number(m[1]));
    }
    const { id: _id, name: _n, createdAt: _c, updatedAt: _u, ...rest } = src;
    const copy = makeServer({ ...rest, name: `${base}-${max + 1}`, agentStatus: 'not_installed' });
    const at = mockServers.items.findIndex((x) => x.id === params.id);
    mockServers.items = [...mockServers.items.slice(0, at + 1), copy, ...mockServers.items.slice(at + 1)];
    return HttpResponse.json(copy, { status: 201 });
  }),
  http.post('/api/servers/reorder', async ({ request }) => {
    const body = (await request.json()) as { ids?: string[] };
    const byId = new Map(mockServers.items.map((s) => [s.id, s]));
    const picked = (body.ids ?? []).map((id) => byId.get(id)).filter((s): s is Server => Boolean(s));
    const rest = mockServers.items.filter((s) => !body.ids?.includes(s.id));
    mockServers.items = [...picked, ...rest];
    return HttpResponse.json({ items: mockServers.items });
  }),
  http.patch('/api/servers/:id', async ({ params, request }) => {
    const parsed = updateServerRequestSchema.safeParse(await request.json());
    if (!parsed.success) return problem(400, 'about:blank', 'Данные не прошли проверку');
    const idx = mockServers.items.findIndex((x) => x.id === params.id);
    if (idx < 0) return problem(404, 'about:blank', 'Сервер не найден');
    const current = mockServers.items[idx] as Server;
    const next: Server = { ...current, ...parsed.data, updatedAt: new Date().toISOString() } as Server;
    mockServers.items[idx] = next;
    return HttpResponse.json(next);
  }),
  http.delete('/api/servers/:id', ({ params }) => {
    const stepUp = requireStepUp();
    if (stepUp) return stepUp;
    mockServers.items = mockServers.items.filter((x) => x.id !== params.id);
    return new HttpResponse(null, { status: 204 });
  }),
  http.post('/api/servers/:id/check', ({ params }) => {
    const idx = mockServers.items.findIndex((x) => x.id === params.id);
    if (idx < 0) return problem(404, 'about:blank', 'Сервер не найден');
    if (mockServers.hostKeyChanged)
      return problem(409, SERVER_PROBLEM.hostKeyMismatch, 'Отпечаток сервера изменился.', {
        expectedFingerprint: MOCK_SSH.fingerprint,
        offeredFingerprint: MOCK_SSH.newFingerprint,
      });
    const next = {
      ...(mockServers.items[idx] as Server),
      sshOk: true,
      lastSshCheckAt: new Date().toISOString(),
      lastSshOkAt: new Date().toISOString(),
    };
    mockServers.items[idx] = next;
    return HttpResponse.json(next);
  }),
  http.post('/api/servers/:id/trust-host-key', async ({ params, request }) => {
    const stepUp = requireStepUp();
    if (stepUp) return stepUp;
    const body = (await request.json()) as { fingerprint?: string };
    const idx = mockServers.items.findIndex((x) => x.id === params.id);
    if (idx < 0) return problem(404, 'about:blank', 'Сервер не найден');
    if (body.fingerprint !== MOCK_SSH.newFingerprint)
      return problem(409, SERVER_PROBLEM.hostKeyMismatch, 'Отпечаток не совпал.', {
        offeredFingerprint: MOCK_SSH.newFingerprint,
      });
    mockServers.hostKeyChanged = false;
    const next = {
      ...(mockServers.items[idx] as Server),
      hostKeyFingerprint: MOCK_SSH.newFingerprint,
      sshOk: true,
    };
    mockServers.items[idx] = next;
    return HttpResponse.json(next);
  }),
  http.post('/api/servers/:id/terminal', ({ params }) => {
    const stepUp = requireStepUp();
    if (stepUp) return stepUp;
    if (!mockServers.items.some((s) => s.id === params.id))
      return problem(404, 'about:blank', 'Сервер не найден');
    return HttpResponse.json({ url: `ws://mock/ws/terminal?server=${params.id}` });
  }),
  http.post('/api/servers/:id/agent/install', ({ params }) => {
    const stepUp = requireStepUp();
    if (stepUp) return stepUp;
    const idx = mockServers.items.findIndex((x) => x.id === params.id);
    if (idx < 0) return problem(404, 'about:blank', 'Сервер не найден');
    const next = { ...(mockServers.items[idx] as Server), agentStatus: 'pending' as const };
    mockServers.items[idx] = next;
    return HttpResponse.json(next);
  }),
  http.post('/api/servers/:id/enrollment-token', ({ params }) => {
    const stepUp = requireStepUp();
    if (stepUp) return stepUp;
    const s = mockServers.items.find((x) => x.id === params.id);
    if (!s) return problem(404, 'about:blank', 'Сервер не найден');
    return HttpResponse.json({
      token: 'nse_mock-token',
      serverId: s.id,
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      installCommand:
        'curl -fsSL https://github.com/feauche/nodeservice-agent/releases/latest/download/install.sh | sh -s -- --token nse_mock-token --panel http://localhost:5173',
    });
  }),
];

export const terminalHistoryHandlers = [
  http.get('/api/servers/:id/terminal/sessions', ({ params, request }) => {
    const url = new URL(request.url);
    const q = (url.searchParams.get('q') ?? '').trim().toLowerCase();
    const since = url.searchParams.get('since');
    let items = mockTerminalSessions.items.filter((s) => s.serverId === params.id);
    if (since) items = items.filter((s) => s.startedAt >= since);
    if (q) {
      items = items
        .map((s) => ({
          ...s,
          matches:
            stripAnsi(mockTerminalSessions.transcripts[s.id] ?? '')
              .toLowerCase()
              .split(q).length - 1,
        }))
        .filter((s) => s.matches > 0);
    }
    return HttpResponse.json({ items });
  }),
  http.get('/api/servers/:id/terminal/sessions/:sid', ({ params, request }) => {
    const s = mockTerminalSessions.items.find((x) => x.id === params.sid && x.serverId === params.id);
    if (!s) return problem(404, 'about:blank', 'Сессия терминала не найдена');
    const full = mockTerminalSessions.transcripts[s.id] ?? '';
    const offset = Number(new URL(request.url).searchParams.get('offset') ?? 0) || 0;
    return HttpResponse.json({ ...s, transcript: full.slice(offset), offset, length: full.length });
  }),
];
