import { SHARED_VERSION } from '@nodeservice/shared';
import { afterEach, describe, expect, it } from 'vitest';

import type { AuditRecordInput } from '../audit/audit.service.js';
import { PANEL_LIFE_KEY, PanelLifecycleService } from './panel-lifecycle.service.js';

/** Valkey в памяти: объект живёт дольше экземпляра службы — как настоящий Valkey при перезапуске панели. */
function makeValkey() {
  const data = new Map<string, string>();
  return {
    data,
    down: false,
    async get(k: string) {
      if (this.down) throw new Error('Connection is closed.');
      return data.get(k) ?? null;
    },
    async set(k: string, v: string) {
      if (this.down) throw new Error('Connection is closed.');
      data.set(k, v);
      return 'OK';
    },
  };
}
type FakeValkey = ReturnType<typeof makeValkey>;

function make(valkey: FakeValkey = makeValkey()) {
  const records: AuditRecordInput[] = [];
  const crashes: Array<{ lastAliveAt: Date; upAt: Date }> = [];
  const svc = new PanelLifecycleService(
    {
      record: async (r: AuditRecordInput) => {
        records.push(r);
        return null;
      },
    } as never,
    { get: () => 'production' } as never,
    valkey as never,
    {
      crashed: async (lastAliveAt: Date, upAt: Date) => {
        crashes.push({ lastAliveAt, upAt });
      },
    } as never,
  );
  return { svc, records, crashes, valkey };
}

const T0 = new Date('2026-10-01T00:00:00Z');
const at = (min: number) => new Date(T0.getTime() + min * 60_000);

describe('запуск панели', () => {
  const saved = process.env.npm_package_version;
  afterEach(() => {
    if (saved === undefined) delete process.env.npm_package_version;
    else process.env.npm_package_version = saved;
  });

  it('«Сервис запущен» — с настоящей версией панели, хотя в образе переменной npm_package_version нет', async () => {
    // Образ запускает `node dist/main` напрямую — npm переменную не задаёт, и в Журнале всегда было 0.1.0.
    delete process.env.npm_package_version;
    const { svc, records } = make();
    await svc.started();
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      action: 'system.started',
      source: 'auto',
      metadata: { version: SHARED_VERSION, env: 'production' },
    });
  });

  it('версия не зависит от того, чем запустили: чужое значение переменной не подменяет версию панели', async () => {
    process.env.npm_package_version = '9.9.9';
    const { svc, records } = make();
    await svc.started();
    expect(records[0]?.metadata?.version).toBe(SHARED_VERSION);
  });
});

describe('отметка штатной остановки и «Панель перезапустилась после сбоя»', () => {
  it('первый запуск (отметок ещё нет) — сбоем не считаем', async () => {
    const { svc, crashes, valkey } = make();
    await svc.started(T0);
    expect(crashes).toHaveLength(0);
    expect(JSON.parse(valkey.data.get(PANEL_LIFE_KEY) ?? '{}')).toMatchObject({
      startedAt: T0.toISOString(),
      aliveAt: T0.toISOString(),
      stoppedAt: null,
    });
  });

  it('штатная остановка ставит отметку — следующий запуск о сбое не говорит', async () => {
    const valkey = makeValkey();
    const first = make(valkey);
    await first.svc.started(T0);
    await first.svc.heartbeat(at(5));
    await first.svc.markStopped(at(7));
    expect(JSON.parse(valkey.data.get(PANEL_LIFE_KEY) ?? '{}').stoppedAt).toBe(at(7).toISOString());
    const next = make(valkey);
    await next.svc.started(at(8));
    expect(next.crashes).toHaveLength(0);
  });

  it('остановки не было (упала, убита за память, сервер выключился) — сообщаем: последний признак жизни и когда поднялась', async () => {
    const valkey = makeValkey();
    const first = make(valkey);
    await first.svc.started(T0);
    await first.svc.heartbeat(at(1));
    await first.svc.heartbeat(at(2));
    // Процесс исчез без остановки — отметки нет.
    const next = make(valkey);
    await next.svc.started(at(4));
    expect(next.crashes).toEqual([{ lastAliveAt: at(2), upAt: at(4) }]);
    // «Сервис запущен» в Журнал пишется и в этом случае.
    expect(next.records.map((r) => r.action)).toEqual(['system.started']);
    // Новый запуск начал свою отметку: ещё один сбой будет считаться от неё.
    expect(JSON.parse(valkey.data.get(PANEL_LIFE_KEY) ?? '{}')).toMatchObject({
      startedAt: at(4).toISOString(),
      stoppedAt: null,
    });
  });

  it('Valkey недоступен при запуске — «Сервис запущен» всё равно записан, о сбое ничего не утверждаем', async () => {
    const valkey = makeValkey();
    valkey.down = true;
    const { svc, records, crashes } = make(valkey);
    await expect(svc.started(T0)).resolves.toBeUndefined();
    expect(records).toHaveLength(1);
    expect(crashes).toHaveLength(0);
    await expect(svc.heartbeat(at(1))).resolves.toBeUndefined();
    await expect(svc.markStopped(at(2))).resolves.toBeUndefined();
  });

  it('до запуска (сквозные тесты не проходят через main.ts) отметки не трогаем', async () => {
    const { svc, valkey } = make();
    await svc.heartbeat(T0);
    await svc.beforeApplicationShutdown();
    expect(valkey.data.size).toBe(0);
  });

  it('после штатной остановки отметка живости её не затирает', async () => {
    const { svc, valkey } = make();
    await svc.started(T0);
    await svc.markStopped(at(3));
    await svc.heartbeat(at(4));
    expect(JSON.parse(valkey.data.get(PANEL_LIFE_KEY) ?? '{}').stoppedAt).toBe(at(3).toISOString());
  });
});
