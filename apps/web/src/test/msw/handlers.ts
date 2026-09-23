import { AUTH_PROBLEM, BRAND_NAME_DEFAULT, type Me } from '@nodeservice/shared';
import { HttpResponse, http } from 'msw';
import { assistantHandlers, seedAssistant } from './assistant-mock';
import { auditHandlers, mockAudit, seedAudit } from './audit-mock';
import { autochecksHandlers, seedAutochecks } from './autochecks-mock';
import { incidentsHandlers, seedIncidents } from './incidents-mock';
import { knowledgeHandlers, seedKnowledge } from './knowledge-mock';
import { maintenanceHandlers } from './maintenance-mock';
import { metricsHandlers, seedMetrics } from './metrics-mock';
import { providersHandlers, seedProviders } from './providers-mock';
import { mockSecurity, securityHandlers, seedSecurity } from './security-mock';
import { seedServers, serversHandlers, terminalHistoryHandlers } from './servers-mock';

/**
 * Мок /api/auth по контракту packages/shared/src/auth.ts.
 * Используется в тестах (node) и в браузере при VITE_MOCK=1.
 * Состояние — в памяти, управляется через mockState / resetMockState().
 */
export const MOCK = {
  login: 'admin',
  password: 'correct horse battery',
  setupToken: 'setup-token-123456',
  totp: '123456',
  recovery: 'K7QFM-2M9XT',
  csrf: 'csrf-token-1',
} as const;

export interface MockState {
  setupRequired: boolean;
  authenticated: boolean;
  pendingTotp: boolean;
  /** Сколько раз подряд неверный пароль; с 5-й — throttle. */
  fails: number;
  throttleUntil: number;
  recoveryLeft: number;
  csrfToken: string;
  /** Сколько запросов подряд отвечать 403 csrf (для теста повтора). */
  csrfRejectOnce: boolean;
  /** Экран заблокирован на сервере. */
  locked: boolean;
}

export const mockSnippets: { items: Array<{ id: string; name: string; command: string }> } = { items: [] };

export const mockAppearance: { logoUrl: string | null; brandName: string } = {
  logoUrl: null,
  brandName: BRAND_NAME_DEFAULT,
};

export const mockState: MockState = {
  setupRequired: false,
  authenticated: false,
  pendingTotp: false,
  fails: 0,
  throttleUntil: 0,
  recoveryLeft: 10,
  csrfToken: MOCK.csrf,
  csrfRejectOnce: false,
  locked: false,
};

mockAudit.authenticated = () => mockState.authenticated;
seedAudit();

export function resetMockState(patch: Partial<MockState> = {}): void {
  seedAudit();
  seedAutochecks();
  seedSecurity();
  seedServers();
  seedProviders();
  seedMetrics();
  seedIncidents();
  seedKnowledge();
  seedAssistant();
  mockSnippets.items = [];
  Object.assign(mockState, {
    setupRequired: false,
    authenticated: false,
    pendingTotp: false,
    fails: 0,
    throttleUntil: 0,
    recoveryLeft: 10,
    csrfToken: MOCK.csrf,
    csrfRejectOnce: false,
    locked: false,
  } satisfies MockState);
  Object.assign(mockState, patch);
}

export const mockMe: Me = {
  id: '01J0000000000000000000000',
  login: MOCK.login,
  amr: ['pwd', 'totp'],
  createdAt: '2026-08-01T10:00:00.000Z',
  stepUpAt: '2026-08-29T09:00:00.000Z',
  recoveryCodesLeft: 10,
  locked: false,
};

/** Me с актуальным числом кодов восстановления из mockState. */
export function currentMe(): Me {
  return { ...mockMe, recoveryCodesLeft: mockState.recoveryLeft, locked: mockState.locked };
}

export function problem(
  status: number,
  type: string,
  detail: string,
  extra: Record<string, unknown> = {},
  headers: Record<string, string> = {},
) {
  const titles: Record<number, string> = {
    400: 'Неверный запрос',
    401: 'Требуется вход',
    403: 'Доступ запрещён',
    409: 'Конфликт',
    422: 'Данные не прошли проверку',
    429: 'Слишком много запросов',
  };
  return HttpResponse.json(
    {
      type,
      title: titles[status] ?? 'Ошибка',
      status,
      detail,
      instance: '/api/auth',
      requestId: 'req-mock',
      ...extra,
    },
    { status, headers: { 'content-type': 'application/problem+json', ...headers } },
  );
}

const csrfGuard = (req: Request) => {
  if (mockState.csrfRejectOnce) {
    mockState.csrfRejectOnce = false;
    return problem(403, 'https://nodeservice.dev/problems/csrf', 'CSRF-токен не совпал.');
  }
  if (req.headers.get('x-csrf-token') !== mockState.csrfToken) {
    return problem(403, 'https://nodeservice.dev/problems/csrf', 'Нет CSRF-токена.');
  }
  return null;
};

const QR_SVG =
  'data:image/svg+xml;utf8,' +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 25 25" shape-rendering="crispEdges"><rect width="25" height="25" fill="#fff"/><path fill="#111" d="M0 0h7v7H0zM18 0h7v7h-7zM0 18h7v7H0zM9 2h1v1H9zM11 2h2v1h-2zM9 5h3v1H9zM14 4h1v3h-1zM2 9h1v2H2zM5 9h2v1H5zM9 9h2v2H9zM13 9h1v1h-1zM16 9h1v2h-1zM19 10h3v1h-3zM21 12h2v1h-2zM9 12h1v3H9zM12 13h2v1h-2zM15 12h1v2h-1zM18 14h1v2h-1zM20 15h3v1h-3zM2 14h3v1H2zM5 12h1v1H5zM9 17h2v1H9zM12 16h1v3h-1zM14 18h2v1h-2zM9 20h1v3H9zM11 21h2v1h-2zM14 20h1v2h-1zM16 21h1v3h-1zM18 19h2v1h-2zM21 18h1v2h-1zM19 21h3v1h-3zM22 23h2v1h-2z"/><path fill="#fff" d="M1 1h5v5H1zM19 1h5v5h-5zM1 19h5v5H1z"/><path fill="#111" d="M2 2h3v3H2zM20 2h3v3h-3zM2 20h3v3H2z"/></svg>',
  );

export const handlers = [
  ...auditHandlers,
  ...autochecksHandlers,
  ...securityHandlers,
  ...serversHandlers,
  ...terminalHistoryHandlers,
  ...maintenanceHandlers,
  ...providersHandlers,
  ...metricsHandlers,
  ...incidentsHandlers,
  ...knowledgeHandlers,
  ...assistantHandlers,
  http.get('/api/settings/snippets', () => {
    if (!mockState.authenticated) return problem(401, AUTH_PROBLEM.unauthenticated, 'Требуется вход');
    return HttpResponse.json(mockSnippets);
  }),
  http.put('/api/settings/snippets', async ({ request }) => {
    if (!mockState.authenticated) return problem(401, AUTH_PROBLEM.unauthenticated, 'Требуется вход');
    const body = (await request.json()) as typeof mockSnippets;
    mockSnippets.items = body.items;
    return HttpResponse.json(mockSnippets);
  }),
  http.get('/api/settings/appearance', () => HttpResponse.json(mockAppearance)),
  http.put('/api/settings/appearance', async ({ request }) => {
    if (!mockState.authenticated) return problem(401, AUTH_PROBLEM.unauthenticated, 'Требуется вход');
    const body = (await request.json()) as { logoUrl?: string | null; brandName?: string };
    if (body.logoUrl !== undefined) mockAppearance.logoUrl = body.logoUrl;
    if (body.brandName !== undefined) mockAppearance.brandName = body.brandName;
    return HttpResponse.json(mockAppearance);
  }),
  http.get('/api/auth/csrf', () => HttpResponse.json({ token: mockState.csrfToken })),

  http.get('/api/auth/status', () =>
    HttpResponse.json({
      setupRequired: mockState.setupRequired,
      authenticated: mockState.authenticated,
      locked: mockState.authenticated && mockState.locked,
    }),
  ),

  http.get('/api/auth/me', () => {
    if (!mockState.authenticated) return problem(401, AUTH_PROBLEM.unauthenticated, 'Нужно войти.');
    return HttpResponse.json(currentMe());
  }),

  http.post('/api/auth/setup/start', async ({ request }) => {
    const bad = csrfGuard(request);
    if (bad) return bad;
    if (!mockState.setupRequired) return problem(409, AUTH_PROBLEM.setupDone, 'Администратор уже создан.');
    const body = (await request.json()) as { setupToken?: string; login?: string; password?: string };
    if (body.setupToken !== MOCK.setupToken)
      return problem(403, AUTH_PROBLEM.setupToken, 'Токен первого запуска не подошёл.');
    return HttpResponse.json({
      totpSecret: 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP',
      otpauthUrl: `otpauth://totp/NodeService:${body.login}?secret=JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP&issuer=NodeService`,
      qrDataUrl: QR_SVG,
    });
  }),

  http.post('/api/auth/setup/confirm', async ({ request }) => {
    const bad = csrfGuard(request);
    if (bad) return bad;
    const body = (await request.json()) as { code?: string };
    if (body.code !== MOCK.totp) return problem(400, AUTH_PROBLEM.invalidTotp, 'Код не подошёл.');
    mockState.setupRequired = false;
    mockState.authenticated = true;
    return HttpResponse.json({
      recoveryCodes: [
        'K7QFM-2M9XT',
        'A3B4C-D5E6F',
        'G7H8J-K9L2M',
        'N3P4Q-R5S6T',
        'U7V8W-X9Y2Z',
        'B2C3D-E4F5G',
        'H6J7K-L8M9N',
        'P2Q3R-S4T5U',
        'V6W7X-Y8Z9A',
        'C3D4E-F5G6H',
      ],
    });
  }),

  http.post('/api/auth/login', async ({ request }) => {
    const bad = csrfGuard(request);
    if (bad) return bad;
    if (mockState.throttleUntil > Date.now()) {
      const left = Math.ceil((mockState.throttleUntil - Date.now()) / 1000);
      return problem(
        429,
        AUTH_PROBLEM.throttled,
        'Слишком много попыток.',
        { retryAfterSeconds: left },
        { 'retry-after': String(left) },
      );
    }
    const body = (await request.json()) as { login?: string; password?: string };
    if (body.login?.toLowerCase() !== MOCK.login || body.password !== MOCK.password) {
      mockState.fails++;
      if (mockState.fails >= 5) {
        mockState.throttleUntil = Date.now() + 30_000;
        return problem(
          429,
          AUTH_PROBLEM.throttled,
          'Слишком много попыток.',
          { retryAfterSeconds: 30 },
          { 'retry-after': '30' },
        );
      }
      return problem(401, AUTH_PROBLEM.invalidCredentials, 'Неверный логин или пароль.');
    }
    mockState.fails = 0;
    mockState.pendingTotp = true;
    return HttpResponse.json({ next: 'totp' });
  }),

  http.post('/api/auth/login/totp', async ({ request }) => {
    const bad = csrfGuard(request);
    if (bad) return bad;
    if (!mockState.pendingTotp) return problem(401, AUTH_PROBLEM.unauthenticated, 'Сначала пароль.');
    const body = (await request.json()) as { code?: string };
    if (body.code !== MOCK.totp) return problem(401, AUTH_PROBLEM.invalidTotp, 'Неверный код.');
    mockState.pendingTotp = false;
    mockState.authenticated = true;
    return HttpResponse.json({ me: currentMe() });
  }),

  http.post('/api/auth/login/recovery', async ({ request }) => {
    const bad = csrfGuard(request);
    if (bad) return bad;
    if (!mockState.pendingTotp) return problem(401, AUTH_PROBLEM.unauthenticated, 'Сначала пароль.');
    const body = (await request.json()) as { code?: string };
    if (body.code?.toUpperCase() !== MOCK.recovery)
      return problem(401, AUTH_PROBLEM.invalidRecovery, 'Код не подошёл.');
    mockState.pendingTotp = false;
    mockState.authenticated = true;
    mockState.recoveryLeft = Math.max(0, mockState.recoveryLeft - 1);
    return HttpResponse.json({
      me: { ...currentMe(), amr: ['pwd', 'recovery'] },
      recoveryCodesLeft: mockState.recoveryLeft,
    });
  }),

  http.post('/api/auth/unlock', async ({ request }) => {
    const bad = csrfGuard(request);
    if (bad) return bad;
    if (!mockState.authenticated) return problem(401, AUTH_PROBLEM.unauthenticated, 'Нужно войти.');
    const body = (await request.json()) as { password?: string };
    if (body.password !== MOCK.password)
      return problem(401, AUTH_PROBLEM.invalidCredentials, 'Неверный пароль.');
    mockSecurity.stepUpFresh = true; // step-up подтверждён
    mockState.locked = false;
    return HttpResponse.json({ me: currentMe() });
  }),

  http.post('/api/auth/lock', ({ request }) => {
    const bad = csrfGuard(request);
    if (bad) return bad;
    if (!mockState.authenticated) return problem(401, AUTH_PROBLEM.unauthenticated, 'Нужно войти.');
    mockState.locked = true;
    return new HttpResponse(null, { status: 204 });
  }),

  http.post('/api/auth/logout', ({ request }) => {
    const bad = csrfGuard(request);
    if (bad) return bad;
    mockState.authenticated = false;
    mockState.pendingTotp = false;
    return new HttpResponse(null, { status: 204 });
  }),
];
