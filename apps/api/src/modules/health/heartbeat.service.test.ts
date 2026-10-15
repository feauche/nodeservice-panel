import { HttpException, HttpStatus } from '@nestjs/common';
import { HEARTBEAT_PROBLEM, SHARED_VERSION } from '@nodeservice/shared';
import { describe, expect, it, vi } from 'vitest';

import { type AddressKind, HeartbeatService, sendProblem } from './heartbeat.service.js';
import type { ReadyState } from './panel-readiness.js';

const URL_OK = 'https://hc-ping.com/5b4e6c8a-1d2f-4c3b-9a8e-7f6d5c4b3a21';
const READY: ReadyState = {
  ok: true,
  problems: [],
  checks: { postgres: { ok: true }, valkey: { ok: true }, incidents: { ok: true } },
};
const NOT_READY: ReadyState = {
  ok: false,
  problems: ['база данных не отвечает', 'поиск инцидентов не отрабатывал 5 мин'],
  checks: {
    postgres: { ok: false, problem: 'база данных не отвечает' },
    valkey: { ok: true },
    incidents: { ok: false, problem: 'поиск инцидентов не отрабатывал 5 мин' },
  },
};

interface Call {
  url: string;
  init: RequestInit | undefined;
}

/** Сервис с app_meta в памяти, подменённой сетью и готовностью. */
function make(opts: { url?: string; ready?: ReadyState; kinds?: Record<string, AddressKind> } = {}) {
  let stored: string | null = opts.url === undefined ? null : JSON.stringify({ url: opts.url });
  const db = {
    query: { appMeta: { findFirst: async () => (stored === null ? undefined : { value: stored }) } },
    insert: () => ({
      values: (row: { value: string }) => ({
        onConflictDoUpdate: async () => {
          stored = row.value;
        },
      }),
    }),
  };
  const readiness = { ready: opts.ready ?? READY, check: async () => readiness.ready };
  const svc = new HeartbeatService(db as never, readiness as never, { get: () => 'production' } as never);
  const calls: Call[] = [];
  let respond: (url: string) => Promise<Response> = async () => new Response('OK', { status: 200 });
  svc.fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    return respond(url);
  }) as typeof fetch;
  svc.addressKind = async (host) => opts.kinds?.[host] ?? 'public';
  return {
    svc,
    calls,
    readiness,
    stored: () => stored,
    respondWith: (fn: (url: string) => Promise<Response>) => {
      respond = fn;
    },
  };
}

describe('сигнал «панель жива»', () => {
  it('адреса нет — ничего не шлёт и состояние пустое', async () => {
    const { svc, calls } = make();
    await svc.beat();
    expect(calls).toHaveLength(0);
    expect(svc.status()).toEqual({
      everySeconds: 60,
      lastAttemptAt: null,
      lastOkAt: null,
      lastResult: null,
      consecutiveFailures: 0,
      recent: [],
    });
  });

  it('панель готова — GET на адрес с версией панели, 2xx — сигнал принят', async () => {
    const { svc, calls } = make({ url: URL_OK });
    await svc.beat();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(URL_OK);
    expect(calls[0]?.init?.method).toBe('GET');
    expect(calls[0]?.init?.redirect).toBe('manual');
    expect((calls[0]?.init?.headers as Record<string, string> | undefined)?.['user-agent']).toBe(
      `nodeservice-panel/${SHARED_VERSION}`,
    );
    const st = svc.status();
    expect(st.lastResult).toMatchObject({ ok: true, sent: true, httpStatus: 200, problem: null });
    expect(st.lastOkAt).toBe(st.lastAttemptAt);
    expect(st.consecutiveFailures).toBe(0);
  });

  it('панель не готова — сигнал НЕ отправляется, в состоянии причина по-русски', async () => {
    const { svc, calls } = make({ url: URL_OK, ready: NOT_READY });
    await svc.beat();
    await svc.beat();
    expect(calls).toHaveLength(0);
    const st = svc.status();
    expect(st.lastResult).toMatchObject({
      ok: false,
      sent: false,
      httpStatus: null,
      ms: null,
      problem: 'не отправлен: база данных не отвечает; поиск инцидентов не отрабатывал 5 мин',
    });
    expect(st.lastOkAt).toBeNull();
    expect(st.consecutiveFailures).toBe(2);
  });

  it('сервис ответил не 2xx — неудача с кодом; следующий удачный сбрасывает счётчик', async () => {
    const { svc, respondWith } = make({ url: URL_OK });
    respondWith(async () => new Response('not found', { status: 404 }));
    await svc.beat();
    expect(svc.status().lastResult).toMatchObject({
      ok: false,
      sent: true,
      httpStatus: 404,
      problem: 'сервис ответил 404',
    });
    expect(svc.status().consecutiveFailures).toBe(1);
    respondWith(async () => new Response('OK', { status: 200 }));
    await svc.beat();
    expect(svc.status().consecutiveFailures).toBe(0);
    expect(svc.status().lastResult?.ok).toBe(true);
  });

  it('сервис молчит — «нет ответа за 10 с», без текста исключения', async () => {
    const { svc, respondWith } = make({ url: URL_OK });
    respondWith(async () => {
      throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    });
    await svc.beat();
    expect(svc.status().lastResult).toMatchObject({ ok: false, sent: true, problem: 'нет ответа за 10 с' });
  });

  it('сетевые ошибки — понятными словами, без адреса и ключа', () => {
    const failed = (code: string) => Object.assign(new TypeError('fetch failed'), { cause: { code } });
    expect(sendProblem(failed('ECONNREFUSED'))).toBe('нет связи с адресом');
    expect(sendProblem(failed('ENOTFOUND'))).toBe('имя сервера не найдено');
    expect(sendProblem(failed('CERT_HAS_EXPIRED'))).toBe('сертификат https не прошёл проверку');
    expect(sendProblem(new DOMException('aborted', 'AbortError'))).toBe('нет ответа за 10 с');
  });

  it('переходы: не больше двух, каждый проверяется на внутреннюю сеть', async () => {
    const { svc, calls, respondWith } = make({
      url: 'https://a.example/ping',
      kinds: { 'inner.example': 'private' },
    });
    respondWith(async (url) =>
      url === 'https://a.example/ping'
        ? new Response(null, { status: 301, headers: { location: 'https://b.example/ping' } })
        : new Response('OK', { status: 200 }),
    );
    await svc.beat();
    expect(calls.map((c) => c.url)).toEqual(['https://a.example/ping', 'https://b.example/ping']);
    expect(svc.status().lastResult?.ok).toBe(true);

    respondWith(
      async () => new Response(null, { status: 302, headers: { location: 'https://inner.example/' } }),
    );
    await svc.beat();
    expect(svc.status().lastResult?.problem).toBe(
      'адрес ведёт во внутреннюю сеть — нужен адрес внешнего сервиса',
    );

    let n = 0;
    respondWith(
      async () => new Response(null, { status: 302, headers: { location: `https://c${++n}.example/` } }),
    );
    await svc.beat();
    expect(svc.status().lastResult?.problem).toBe('слишком много перенаправлений');
  });

  it('пока идёт прошлый сигнал, новый не начинается', async () => {
    const { svc, calls, respondWith } = make({ url: URL_OK });
    let release: () => void = () => undefined;
    respondWith(
      () =>
        new Promise<Response>((resolve) => {
          release = () => resolve(new Response('OK'));
        }),
    );
    const first = svc.beat();
    const second = svc.beat();
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    release();
    await Promise.all([first, second]);
    expect(calls).toHaveLength(1);
  });

  it('сохранение: внутренняя сеть — 400 у поля; новый адрес сбрасывает итоги и сразу шлёт сигнал', async () => {
    const { svc, calls, stored } = make({ url: URL_OK, kinds: { '192.168.1.5': 'private' } });
    await svc.beat();
    expect(svc.status().lastOkAt).not.toBeNull();

    const err = await svc.update({ url: 'http://192.168.1.5:3001/api/push/x' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpException);
    expect((err as HttpException).getStatus()).toBe(HttpStatus.BAD_REQUEST);
    expect((err as HttpException).getResponse()).toMatchObject({
      type: HEARTBEAT_PROBLEM.privateAddress,
      errors: [{ path: 'url' }],
    });
    expect(JSON.parse(stored() ?? '{}').url).toBe(URL_OK);

    const next = 'https://uptime.betterstack.com/api/v1/heartbeat/AbC';
    const { view, before, after } = await svc.update({ url: next });
    expect({ before, after }).toEqual({ before: URL_OK, after: next });
    expect(view.url).toBe(next);
    expect(view.status.lastResult).toBeNull();
    await vi.waitFor(() => expect(calls.at(-1)?.url).toBe(next));
    await vi.waitFor(() => expect(svc.status().lastResult?.ok).toBe(true));

    // Выключили — больше не шлёт.
    await svc.update({ url: '' });
    const sent = calls.length;
    await svc.beat();
    expect(calls).toHaveLength(sent);
    expect((await svc.view()).url).toBe('');
  });

  it('проверка: шлёт даже неготовой панели и говорит об этом; не чаще раза в 5 с', async () => {
    const { svc, calls, readiness } = make({ url: URL_OK, ready: NOT_READY });
    let now = 1_000_000;
    svc.now = () => now;
    const res = await svc.test();
    expect(calls).toHaveLength(1);
    expect(res).toMatchObject({
      ok: true,
      httpStatus: 200,
      problem: null,
      ready: false,
      notReady: NOT_READY.problems,
      host: 'hc-ping.com',
    });
    // Проверили сохранённый адрес — сигнал засчитан.
    expect(svc.status().lastResult).toMatchObject({ ok: true, sent: true });

    now += 2_000;
    const tooOften = await svc.test().catch((e: unknown) => e);
    expect((tooOften as HttpException).getStatus()).toBe(HttpStatus.TOO_MANY_REQUESTS);
    expect(calls).toHaveLength(1);

    // Другой, ещё не сохранённый адрес — проверяем его, а состояние сохранённого не трогаем.
    now += 5_000;
    readiness.ready = READY;
    const before = svc.status();
    const other = await svc.test('https://kuma.example.com/api/push/zz?status=up');
    expect(other).toMatchObject({ ok: true, ready: true, notReady: [] });
    expect(calls.at(-1)?.url).toBe('https://kuma.example.com/api/push/zz?status=up');
    expect(svc.status()).toEqual(before);
  });

  it('проверка без адреса — 400 «укажите адрес»', async () => {
    const { svc } = make();
    const err = await svc.test().catch((e: unknown) => e);
    expect((err as HttpException).getStatus()).toBe(HttpStatus.BAD_REQUEST);
    expect((err as HttpException).getResponse()).toMatchObject({ type: HEARTBEAT_PROBLEM.noUrl });
  });

  it('полоса за час: принят, придержан, не принят; старше часа и после смены адреса — забыто', async () => {
    const { svc, readiness, respondWith } = make({ url: URL_OK });
    let now = Date.parse('2026-10-15T10:00:00Z');
    svc.now = () => now;
    await svc.beat();
    now += 60_000;
    readiness.ready = NOT_READY;
    await svc.beat();
    now += 60_000;
    readiness.ready = READY;
    respondWith(async () => new Response('нет', { status: 404 }));
    await svc.beat();
    expect(svc.status().recent).toEqual([
      { at: '2026-10-15T10:00:00.000Z', outcome: 'ok' },
      { at: '2026-10-15T10:01:00.000Z', outcome: 'held' },
      { at: '2026-10-15T10:02:00.000Z', outcome: 'failed' },
    ]);
    now += 58 * 60_000 + 30_000;
    expect(svc.status().recent.map((a) => a.outcome)).toEqual(['held', 'failed']);
    await svc.update({ url: 'https://hc-ping.com/другая' });
    expect(svc.status().recent.length).toBeLessThanOrEqual(1);
  });

  it('повреждённая запись — сигнал выключен, а не падение', async () => {
    const { svc, calls } = make();
    // biome-ignore lint/suspicious/noExplicitAny: подмена хранилища в тесте
    (svc as any).db.query.appMeta.findFirst = async () => ({ value: '{not json' });
    await svc.beat();
    expect(calls).toHaveLength(0);
    expect((await svc.view()).url).toBe('');
  });
});
