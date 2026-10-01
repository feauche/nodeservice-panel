import { HttpException, HttpStatus } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { HealthController, NOT_READY_PROBLEM } from './health.controller.js';
import { PanelPulse } from './panel-pulse.js';

const VM_URL = 'http://vm.test:8428';
/** Сырой текст ошибки базы — с адресом и паролем: наружу он попадать не должен. */
const DB_ERROR = 'connect ECONNREFUSED postgres://nodeservice:s3cret-pass@postgres:5432/nodeservice';
const never = () => new Promise<never>(() => undefined);

interface Parts {
  db?: () => Promise<unknown>;
  ping?: () => Promise<string>;
  vm?: () => Promise<Response>;
  /** Поиск инцидентов уже отработал (по умолчанию — только что). */
  ticked?: boolean;
}

function make(parts: Parts = {}) {
  const pulse = new PanelPulse();
  if (parts.ticked !== false) pulse.incidentsTick();
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
    expect(String(url)).toBe(`${VM_URL}/health`);
    return parts.vm ? parts.vm() : new Response('OK', { status: 200 });
  });
  const ctrl = new HealthController(
    { execute: parts.db ?? (async () => ({ rows: [{ '?column?': 1 }] })) } as never,
    { ping: parts.ping ?? (async () => 'PONG') } as never,
    { get: (k: string) => (k === 'VM_URL' ? VM_URL : undefined) } as never,
    pulse,
  );
  // Ожидание каждой проверки сокращаем: зависшая часть должна давать 503, а не держать тест.
  ctrl.timeoutMs = 50;
  return { ctrl, pulse };
}

/** 503 с перечнем того, что не так: тело ответа — как его отдаст фильтр problem+json. */
async function notReady(ctrl: HealthController) {
  const err = await ctrl.ready().then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(HttpException);
  const ex = err as HttpException;
  expect(ex.getStatus()).toBe(HttpStatus.SERVICE_UNAVAILABLE);
  const body = ex.getResponse() as {
    type: string;
    detail: string;
    extensions: { problems: string[]; checks: Record<string, { ok: boolean }> };
  };
  expect(body.type).toBe(NOT_READY_PROBLEM);
  return body;
}

describe('/api/health/ready — готовность по-настоящему', () => {
  beforeEach(() => vi.useRealTimers());
  afterEach(() => vi.restoreAllMocks());

  it('всё работает — 200 и что проверено', async () => {
    const { ctrl } = make();
    const res = await ctrl.ready();
    expect(res.status).toBe('ok');
    expect(Object.keys(res.checks).sort()).toEqual(['incidents', 'metrics', 'postgres', 'valkey']);
    for (const c of Object.values(res.checks)) expect(c.ok).toBe(true);
  });

  it('база данных не отвечает — 503 с причиной, без адреса и пароля из текста ошибки', async () => {
    const { ctrl } = make({
      db: async () => {
        throw new Error(DB_ERROR);
      },
    });
    const body = await notReady(ctrl);
    expect(body.extensions.problems).toEqual(['база данных не отвечает']);
    expect(body.detail).toBe('база данных не отвечает');
    expect(body.extensions.checks.postgres?.ok).toBe(false);
    expect(body.extensions.checks.valkey?.ok).toBe(true);
    expect(JSON.stringify(body)).not.toMatch(/s3cret|ECONNREFUSED|postgres:\/\//);
  });

  it('база данных зависла — не ждём её вечно: 503 по таймауту', async () => {
    const { ctrl } = make({ db: never });
    expect((await notReady(ctrl)).extensions.problems).toEqual(['база данных не отвечает']);
  });

  it('Valkey не отвечает или отвечает не то — 503', async () => {
    const down = make({
      ping: async () => {
        throw new Error('Connection is closed.');
      },
    });
    expect((await notReady(down.ctrl)).extensions.problems).toEqual(['хранилище сессий не отвечает']);
    vi.restoreAllMocks();
    const odd = make({ ping: async () => 'LOADING' });
    expect((await notReady(odd.ctrl)).extensions.problems).toEqual(['хранилище сессий не отвечает']);
  });

  it('хранилище метрик не отвечает или отвечает ошибкой — 503', async () => {
    const down = make({
      vm: async () => {
        throw new TypeError('fetch failed');
      },
    });
    expect((await notReady(down.ctrl)).extensions.problems).toEqual(['хранилище метрик не отвечает']);
    vi.restoreAllMocks();
    const bad = make({ vm: async () => new Response('storage full', { status: 500 }) });
    expect((await notReady(bad.ctrl)).extensions.problems).toEqual(['хранилище метрик не отвечает']);
    vi.restoreAllMocks();
    const hung = make({ vm: never });
    expect((await notReady(hung.ctrl)).extensions.problems).toEqual(['хранилище метрик не отвечает']);
  });

  it('поиск инцидентов не отрабатывал больше 3 минут — 503, хотя всё остальное отвечает', async () => {
    const { ctrl, pulse } = make();
    pulse.incidentsTick(Date.now() - 4 * 60_000);
    const body = await notReady(ctrl);
    expect(body.extensions.problems).toEqual(['поиск инцидентов не отрабатывал 4 мин']);
    expect(body.extensions.checks.postgres?.ok).toBe(true);
    // Отработал — снова готова.
    pulse.incidentsTick();
    expect((await ctrl.ready()).status).toBe('ok');
  });

  it('только что запущенная панель готова, пока поиск инцидентов не успел отработать; через 3 минуты — уже нет', async () => {
    const { ctrl, pulse } = make({ ticked: false });
    pulse.startedAt = Date.now() - 60_000;
    expect((await ctrl.ready()).status).toBe('ok');
    pulse.startedAt = Date.now() - 5 * 60_000;
    expect((await notReady(ctrl)).extensions.problems).toEqual(['поиск инцидентов не отрабатывал 5 мин']);
  });

  it('несколько бед сразу — все в перечне, через точку с запятой', async () => {
    const { ctrl, pulse } = make({
      db: async () => {
        throw new Error(DB_ERROR);
      },
      vm: never,
    });
    pulse.incidentsTick(Date.now() - 10 * 60_000);
    const body = await notReady(ctrl);
    expect(body.extensions.problems).toEqual([
      'база данных не отвечает',
      'хранилище метрик не отвечает',
      'поиск инцидентов не отрабатывал 10 мин',
    ]);
    expect(body.detail).toBe(
      'база данных не отвечает; хранилище метрик не отвечает; поиск инцидентов не отрабатывал 10 мин',
    );
  });

  it('/api/health/live по-прежнему отвечает без проверок: по нему Docker перезапускает контейнер', () => {
    const { ctrl } = make({ db: never, ping: never, vm: never });
    expect(ctrl.live().status).toBe('ok');
  });
});
