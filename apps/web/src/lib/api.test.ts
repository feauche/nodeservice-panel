import { AUTH_PROBLEM, authStatusSchema, loginResponseSchema } from '@nodeservice/shared';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import { MOCK, mockState, problem } from '@/test/msw/handlers';
import { server } from '@/test/msw/server';
import { ApiError, api, apiErrorMessage, CSRF_HEADER, formatSeconds, isApiError, request } from './api';

describe('api', () => {
  it('GET парсит ответ по схеме', async () => {
    const st = await api.get('/auth/status', authStatusSchema);
    expect(st).toEqual({ setupRequired: false, authenticated: false, locked: false });
  });

  it('на не-GET один раз берёт CSRF и шлёт заголовок x-csrf-token', async () => {
    let csrfCalls = 0;
    const seen: string[] = [];
    server.use(
      http.get('/api/auth/csrf', () => {
        csrfCalls++;
        return HttpResponse.json({ token: 'tok-1' });
      }),
      http.post('/api/auth/login', ({ request }) => {
        seen.push(request.headers.get(CSRF_HEADER) ?? '');
        return HttpResponse.json({ next: 'totp' });
      }),
    );
    await api.post('/auth/login', { login: 'a', password: 'b' }, loginResponseSchema);
    await api.post('/auth/login', { login: 'a', password: 'b' }, loginResponseSchema);
    expect(csrfCalls).toBe(1);
    expect(seen).toEqual(['tok-1', 'tok-1']);
  });

  it('при 403 csrf обновляет токен и повторяет запрос один раз', async () => {
    mockState.csrfRejectOnce = true;
    const res = await api.post(
      '/auth/login',
      { login: MOCK.login, password: MOCK.password },
      loginResponseSchema,
    );
    expect(res).toEqual({ next: 'totp' });
    // второй 403 подряд — уже ошибка наружу
    mockState.csrfRejectOnce = true;
    mockState.csrfToken = 'rotated';
    server.use(http.get('/api/auth/csrf', () => HttpResponse.json({ token: 'stale' })));
    await expect(
      api.post('/auth/login', { login: 'a', password: 'b' }, loginResponseSchema),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('application/problem+json → ApiError со всеми полями', async () => {
    server.use(
      http.post('/api/auth/login', () =>
        problem(
          429,
          AUTH_PROBLEM.throttled,
          'Слишком много попыток.',
          { retryAfterSeconds: 30, errors: [{ path: 'login', message: 'x' }] },
          { 'retry-after': '30' },
        ),
      ),
    );
    const err = await api
      .post('/auth/login', { login: 'a', password: 'b' }, loginResponseSchema)
      .catch((e) => e);
    expect(isApiError(err)).toBe(true);
    const e = err as ApiError;
    expect(e.status).toBe(429);
    expect(e.type).toBe(AUTH_PROBLEM.throttled);
    expect(e.title).toBe('Слишком много запросов');
    expect(e.detail).toBe('Слишком много попыток.');
    expect(e.retryAfterSeconds).toBe(30);
    expect(e.requestId).toBe('req-mock');
    expect(e.fieldMessage('login')).toBe('x');
    expect(apiErrorMessage(e)).toContain('пауза 0:30');
  });

  it('Retry-After из заголовка, если в теле нет', async () => {
    server.use(
      http.post('/api/auth/login', () =>
        HttpResponse.json(
          { type: AUTH_PROBLEM.throttled, title: 'x', status: 429 },
          { status: 429, headers: { 'content-type': 'application/problem+json', 'retry-after': '61' } },
        ),
      ),
    );
    const e = (await request('/auth/login', { method: 'POST', body: {} }).catch((x) => x)) as ApiError;
    expect(e.retryAfterSeconds).toBe(61);
  });

  it('не-JSON ответ (упавший прокси) → ApiError без падения', async () => {
    server.use(http.get('/api/auth/status', () => new HttpResponse('<h1>502</h1>', { status: 502 })));
    const e = (await api.get('/auth/status', authStatusSchema).catch((x) => x)) as ApiError;
    expect(e.status).toBe(502);
    expect(e.type).toBe('about:blank');
    expect(apiErrorMessage(e)).toContain('сервере');
  });

  it('ответ не по контракту → ApiError bad-response', async () => {
    server.use(http.get('/api/auth/status', () => HttpResponse.json({ nope: 1 })));
    const e = (await api.get('/auth/status', authStatusSchema).catch((x) => x)) as ApiError;
    expect(e.type).toContain('bad-response');
  });

  it('сообщения по типам', () => {
    const mk = (type: string, status = 400) => new ApiError({ type, title: 't', status });
    expect(apiErrorMessage(mk(AUTH_PROBLEM.invalidCredentials, 401))).toBe('Неверный логин или пароль.');
    expect(apiErrorMessage(mk(AUTH_PROBLEM.invalidTotp))).toContain('Неверный код');
    expect(apiErrorMessage(mk(AUTH_PROBLEM.invalidRecovery))).toContain('использован');
    expect(apiErrorMessage(new ApiError({ type: 'about:blank', title: 'x', status: 0 }))).toContain(
      'Нет связи',
    );
    expect(apiErrorMessage(new Error('boom'))).toBe('boom');
    expect(formatSeconds(90)).toBe('1:30');
    expect(formatSeconds(5)).toBe('0:05');
  });
});

describe('истёкшая сессия (401 unauthenticated)', () => {
  it('зовёт обработчик для путей вне auth-потока и молчит для /auth/*', async () => {
    const { setUnauthenticatedHandler } = await import('./api');
    const seen: string[] = [];
    setUnauthenticatedHandler((p) => seen.push(p));
    server.use(
      http.get('/api/nodes', () => problem(401, AUTH_PROBLEM.unauthenticated, 'Нужно войти.')),
      http.post('/api/auth/unlock', () => problem(401, AUTH_PROBLEM.unauthenticated, 'Нужно войти.')),
      http.get('/api/auth/me', () => problem(401, AUTH_PROBLEM.unauthenticated, 'Нужно войти.')),
      http.get('/api/auth/status', () => problem(401, AUTH_PROBLEM.unauthenticated, 'Нужно войти.')),
      http.post('/api/auth/login/totp', () => problem(401, AUTH_PROBLEM.unauthenticated, 'Нужно войти.')),
      http.get('/api/other', () => problem(401, AUTH_PROBLEM.invalidCredentials, 'x')),
    );
    try {
      await expect(api.get('/nodes', authStatusSchema)).rejects.toMatchObject({ status: 401 });
      await expect(request('/auth/unlock', { method: 'POST', body: {} })).rejects.toMatchObject({
        status: 401,
      });
      await expect(api.get('/auth/me', authStatusSchema)).rejects.toMatchObject({ status: 401 });
      await expect(api.get('/auth/status', authStatusSchema)).rejects.toMatchObject({ status: 401 });
      await expect(request('/auth/login/totp', { method: 'POST', body: {} })).rejects.toMatchObject({
        status: 401,
      });
      await expect(api.get('/other', authStatusSchema)).rejects.toMatchObject({ status: 401 });
    } finally {
      setUnauthenticatedHandler(null);
    }
    expect(seen).toEqual(['/nodes']);
  });
});
