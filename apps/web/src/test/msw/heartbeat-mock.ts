import {
  HEARTBEAT_EVERY_SECONDS,
  HEARTBEAT_PROBLEM,
  type HeartbeatAttempt,
  type HeartbeatResult,
  type HeartbeatTestResponse,
  type HeartbeatView,
  heartbeatSettingsSchema,
  heartbeatTestRequestSchema,
} from '@nodeservice/shared';
import { HttpResponse, http } from 'msw';

/**
 * Мок сигнала «панель жива». Ответ «сервиса» — по адресу, чтобы в демо и тестах были видны все исходы:
 * в адресе «404» — «сервис ответил 404», «timeout» — «нет ответа за 10 с», «nohost» — «имя сервера не найдено»,
 * адрес во внутренней сети (localhost, 192.168.…, 10.…) — 400 у поля; иначе сигнал принят.
 * `mockHeartbeat.notReady` — панель «не готова»: обычный сигнал не уходит, проверка говорит почему.
 */
export const mockHeartbeat = {
  view: null as unknown as HeartbeatView,
  notReady: [] as string[],
};

export function resetHeartbeat(): void {
  mockHeartbeat.notReady = [];
  mockHeartbeat.view = {
    url: '',
    status: {
      everySeconds: HEARTBEAT_EVERY_SECONDS,
      lastAttemptAt: null,
      lastOkAt: null,
      lastResult: null,
      consecutiveFailures: 0,
      recent: [],
    },
  };
}
resetHeartbeat();

const problem = (status: number, type: string, detail: string, extra: Record<string, unknown> = {}) =>
  HttpResponse.json(
    { type, title: detail, status, detail, ...extra },
    { status, headers: { 'content-type': 'application/problem+json' } },
  );

const PRIVATE = /^https?:\/\/(?:localhost|127\.|10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/i;

function answer(url: string): Pick<HeartbeatResult, 'ok' | 'httpStatus' | 'ms' | 'problem'> {
  if (url.includes('404')) return { ok: false, httpStatus: 404, ms: 212, problem: 'сервис ответил 404' };
  if (url.includes('timeout'))
    return { ok: false, httpStatus: null, ms: 10_000, problem: 'нет ответа за 10 с' };
  if (url.includes('nohost'))
    return { ok: false, httpStatus: null, ms: 38, problem: 'имя сервера не найдено' };
  return { ok: true, httpStatus: 200, ms: 184, problem: null };
}

function record(r: Omit<HeartbeatResult, 'at'>) {
  const s = mockHeartbeat.view.status;
  const at = new Date().toISOString();
  s.lastAttemptAt = at;
  s.lastResult = { ...r, at };
  const outcome: HeartbeatAttempt['outcome'] = r.ok ? 'ok' : r.sent ? 'failed' : 'held';
  s.recent = [...s.recent, { at, outcome }].slice(-120);
  if (r.ok) {
    s.lastOkAt = at;
    s.consecutiveFailures = 0;
  } else s.consecutiveFailures += 1;
}

/** Как задача на сервере: один сигнал на сохранённый адрес (или «не отправлен», если панель не готова). */
export function mockHeartbeatBeat(): void {
  const { url } = mockHeartbeat.view;
  if (!url) return;
  if (mockHeartbeat.notReady.length) {
    record({
      ok: false,
      sent: false,
      httpStatus: null,
      ms: null,
      problem: `не отправлен: ${mockHeartbeat.notReady.join('; ')}`,
    });
    return;
  }
  record({ ...answer(url), sent: true });
}

export const heartbeatHandlers = [
  http.get('/api/settings/heartbeat', () => HttpResponse.json(mockHeartbeat.view)),
  http.put('/api/settings/heartbeat', async ({ request }) => {
    const p = heartbeatSettingsSchema.safeParse(await request.json());
    if (!p.success)
      return problem(422, 'about:blank', 'Проверьте поля', {
        errors: p.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    if (PRIVATE.test(p.data.url))
      return problem(
        400,
        HEARTBEAT_PROBLEM.privateAddress,
        'Адрес ведёт во внутреннюю сеть. Нужен адрес внешнего сервиса проверки.',
        {
          errors: [{ path: 'url', message: 'Нужен адрес внешнего сервиса, не внутренней сети' }],
        },
      );
    if (p.data.url !== mockHeartbeat.view.url) {
      resetHeartbeat();
      mockHeartbeat.view.url = p.data.url;
      // Как на сервере: новый адрес — сразу первый сигнал.
      mockHeartbeatBeat();
    }
    return HttpResponse.json(mockHeartbeat.view);
  }),
  http.post('/api/settings/heartbeat/test', async ({ request }) => {
    const p = heartbeatTestRequestSchema.safeParse(await request.json().catch(() => ({})));
    if (!p.success)
      return problem(422, 'about:blank', 'Проверьте поля', {
        errors: p.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    const target = p.data.url || mockHeartbeat.view.url;
    if (!target)
      return problem(400, HEARTBEAT_PROBLEM.noUrl, 'Сначала укажите адрес сервиса проверки.', {
        errors: [{ path: 'url', message: 'Укажите адрес сервиса проверки' }],
      });
    const sent = PRIVATE.test(target)
      ? {
          ok: false,
          httpStatus: null,
          ms: 1,
          problem: 'адрес ведёт во внутреннюю сеть — нужен адрес внешнего сервиса',
        }
      : answer(target);
    if (target === mockHeartbeat.view.url) record({ ...sent, sent: true });
    const res: HeartbeatTestResponse = {
      ok: sent.ok,
      httpStatus: sent.httpStatus,
      ms: sent.ms ?? 0,
      problem: sent.problem,
      ready: mockHeartbeat.notReady.length === 0,
      notReady: [...mockHeartbeat.notReady],
    };
    return HttpResponse.json(res);
  }),
];
