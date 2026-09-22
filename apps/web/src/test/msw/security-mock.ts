import {
  AUTH_PROBLEM,
  SECURITY_POLICY_DEFAULTS,
  SECURITY_PROBLEM,
  type SecurityOverview,
  type SecurityPolicy,
  type SessionInfo,
  type TrustedDeviceInfo,
} from '@nodeservice/shared';
import { HttpResponse, http } from 'msw';

/** Мок «Безопасности»: состояние в памяти, step-up имитируется флагом stepUpFresh. */
export const MOCK_SECURITY = {
  password: 'correct horse battery',
  pwnedPassword: 'password123password',
  totpCode: '123456',
  totpSecret: 'JBSWY3DPEHPK3PXP',
} as const;

interface SecurityMock {
  stepUpFresh: boolean;
  policy: SecurityPolicy;
  passwordChangedAt: string;
  totpConfirmedAt: string;
  recoveryLeft: number;
  sessions: SessionInfo[];
  devices: TrustedDeviceInfo[];
  reissuePending: boolean;
  codes: Array<{ code: string | null; usedAt: string | null }>;
}

export const mockSecurity: SecurityMock = {
  stepUpFresh: true,
  policy: { ...SECURITY_POLICY_DEFAULTS },
  passwordChangedAt: '2026-08-01T10:00:00.000Z',
  totpConfirmedAt: '2026-08-01T10:05:00.000Z',
  recoveryLeft: 10,
  sessions: [],
  devices: [],
  reissuePending: false,
  codes: [],
};

export function seedSecurity(): void {
  mockSecurity.stepUpFresh = true;
  mockSecurity.policy = { ...SECURITY_POLICY_DEFAULTS };
  mockSecurity.recoveryLeft = 10;
  mockSecurity.reissuePending = false;
  mockSecurity.codes = Array.from({ length: 10 }, (_, i) => ({
    code: `RC${String(i).padStart(3, '0')}-${String(i * 7).padStart(5, '0')}`,
    usedAt: i === 3 || i === 7 ? '2026-08-20T10:00:00.000Z' : null,
  }));
  mockSecurity.recoveryLeft = 8;
  mockSecurity.sessions = [
    {
      id: 'aaaaaaaaaaaaaaaa',
      current: true,
      createdAt: '2026-08-29T17:00:00.000Z',
      lastSeenAt: new Date().toISOString(),
      expiresAt: '2026-08-30T05:00:00.000Z',
      ip: '203.0.113.7',
      userAgent: 'Mozilla/5.0 (Macintosh) Chrome/140',
      amr: ['pwd', 'totp'],
    },
    {
      id: 'bbbbbbbbbbbbbbbb',
      current: false,
      createdAt: '2026-08-28T09:00:00.000Z',
      lastSeenAt: '2026-08-29T12:00:00.000Z',
      expiresAt: '2026-08-29T21:00:00.000Z',
      ip: '198.51.100.20',
      userAgent: 'Mozilla/5.0 (iPhone) Version/18.0 Safari',
      amr: ['pwd', 'trusted'],
    },
  ];
  mockSecurity.devices = [
    {
      id: '0192b6e0-4c1e-7c3a-9c2d-000000000001',
      current: true,
      userAgent: 'Mozilla/5.0 (Macintosh) Chrome/140',
      ipPrefix: '203.0.113.0/24',
      createdAt: '2026-08-20T10:00:00.000Z',
      lastUsedAt: '2026-08-29T17:00:00.000Z',
      expiresAt: '2026-09-19T10:00:00.000Z',
    },
  ];
}
seedSecurity();
// Режим VITE_MOCK=1: доступ к состоянию из консоли/скриптов (например, stepUpFresh=false — показать диалог пароля).
if (typeof window !== 'undefined') (window as unknown as { __nsMock: SecurityMock }).__nsMock = mockSecurity;

function problem(status: number, type: string, detail: string) {
  return HttpResponse.json(
    { type, title: detail, status, detail },
    { status, headers: { 'content-type': 'application/problem+json' } },
  );
}

function stepUp() {
  return problem(403, AUTH_PROBLEM.stepUp, 'Нужно ещё раз подтвердить пароль.');
}

const me = () => ({
  id: 'u1',
  login: 'admin',
  amr: ['pwd', 'totp'],
  createdAt: '2026-08-01T10:00:00.000Z',
  stepUpAt: new Date().toISOString(),
  recoveryCodesLeft: mockSecurity.recoveryLeft,
});

export const securityHandlers = [
  http.get('/api/security/overview', () => {
    const body: SecurityOverview = {
      login: 'admin',
      passwordChangedAt: mockSecurity.passwordChangedAt,
      totpConfirmedAt: mockSecurity.totpConfirmedAt,
      recoveryCodesLeft: mockSecurity.recoveryLeft,
      recoveryCodesTotal: 10,
      sessionsCount: mockSecurity.sessions.length,
      trustedDevicesCount: mockSecurity.devices.length,
      policy: mockSecurity.policy,
    };
    return HttpResponse.json(body);
  }),
  http.post('/api/security/password', async ({ request }) => {
    const body = (await request.json()) as { currentPassword: string; newPassword: string };
    if (body.currentPassword !== MOCK_SECURITY.password)
      return problem(401, AUTH_PROBLEM.invalidCredentials, 'Неверный логин или пароль.');
    if (body.newPassword === MOCK_SECURITY.pwnedPassword)
      return HttpResponse.json(
        {
          type: SECURITY_PROBLEM.passwordPwned,
          title: 'Пароль в утечках',
          status: 400,
          errors: [{ path: 'newPassword', message: 'Пароль есть в утечках — выбери другой' }],
        },
        { status: 400 },
      );
    const revoked = mockSecurity.sessions.filter((s) => !s.current).length;
    mockSecurity.sessions = mockSecurity.sessions.filter((s) => s.current);
    mockSecurity.passwordChangedAt = new Date().toISOString();
    mockSecurity.stepUpFresh = true;
    return HttpResponse.json({ me: me(), sessionsRevoked: revoked });
  }),
  http.post('/api/security/totp/reissue', () => {
    if (!mockSecurity.stepUpFresh) return stepUp();
    mockSecurity.reissuePending = true;
    return HttpResponse.json({
      totpSecret: MOCK_SECURITY.totpSecret,
      otpauthUrl: `otpauth://totp/NodeService:admin?secret=${MOCK_SECURITY.totpSecret}`,
      qrDataUrl: 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciLz4=',
    });
  }),
  http.post('/api/security/totp/confirm', async ({ request }) => {
    const body = (await request.json()) as { code: string };
    if (!mockSecurity.reissuePending)
      return problem(400, SECURITY_PROBLEM.totpReissueExpired, 'Перевыпуск не начат или истёк.');
    if (body.code !== MOCK_SECURITY.totpCode) return problem(401, AUTH_PROBLEM.invalidTotp, 'Неверный код.');
    mockSecurity.reissuePending = false;
    mockSecurity.totpConfirmedAt = new Date().toISOString();
    const devices = mockSecurity.devices.length;
    const revoked = mockSecurity.sessions.filter((s) => !s.current).length;
    mockSecurity.devices = [];
    mockSecurity.sessions = mockSecurity.sessions.filter((s) => s.current);
    return HttpResponse.json({ me: me(), sessionsRevoked: revoked, trustedDevicesRemoved: devices });
  }),
  http.get('/api/security/recovery-codes', () => {
    if (!mockSecurity.stepUpFresh) return stepUp();
    return HttpResponse.json({ codes: mockSecurity.codes });
  }),
  http.post('/api/security/recovery-codes', () => {
    if (!mockSecurity.stepUpFresh) return stepUp();
    mockSecurity.recoveryLeft = 10;
    mockSecurity.codes = mockSecurity.codes.map((c) => ({ ...c, usedAt: null }));
    return HttpResponse.json({
      recoveryCodes: Array.from(
        { length: 10 },
        (_, i) => `RC${String(i).padStart(3, '0')}-${String(i * 7).padStart(5, '0')}`,
      ),
    });
  }),
  http.get('/api/security/sessions', () => HttpResponse.json({ items: mockSecurity.sessions })),
  http.delete('/api/security/sessions/:id', ({ params }) => {
    const target = mockSecurity.sessions.find((s) => s.id === params.id);
    if (!target) return HttpResponse.json({ revoked: 0 });
    if (target.current) return problem(400, SECURITY_PROBLEM.currentSession, 'Это текущая сессия.');
    mockSecurity.sessions = mockSecurity.sessions.filter((s) => s.id !== params.id);
    return HttpResponse.json({ revoked: 1 });
  }),
  http.post('/api/security/sessions/revoke-others', () => {
    const revoked = mockSecurity.sessions.filter((s) => !s.current).length;
    mockSecurity.sessions = mockSecurity.sessions.filter((s) => s.current);
    return HttpResponse.json({ revoked });
  }),
  http.get('/api/security/trusted-devices', () => HttpResponse.json({ items: mockSecurity.devices })),
  http.delete('/api/security/trusted-devices/:id', ({ params }) => {
    const before = mockSecurity.devices.length;
    mockSecurity.devices = mockSecurity.devices.filter((d) => d.id !== params.id);
    return HttpResponse.json({ revoked: before - mockSecurity.devices.length });
  }),
  http.post('/api/security/trusted-devices/clear', () => {
    const revoked = mockSecurity.devices.length;
    mockSecurity.devices = [];
    return HttpResponse.json({ revoked });
  }),
  http.get('/api/security/policy', () => HttpResponse.json(mockSecurity.policy)),
  http.put('/api/security/policy', async ({ request }) => {
    if (!mockSecurity.stepUpFresh) return stepUp();
    const patch = (await request.json()) as Partial<SecurityPolicy>;
    mockSecurity.policy = { ...mockSecurity.policy, ...patch };
    return HttpResponse.json(mockSecurity.policy);
  }),
];
