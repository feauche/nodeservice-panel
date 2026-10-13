import { MONITORING_DEFAULTS } from '@nodeservice/shared';
import { PgDialect } from 'drizzle-orm/pg-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FleetMonitorJob } from '../incidents/fleet-monitor.job.js';
import { ScenariosJob } from './scenarios.job.js';

/**
 * Вся цепочка при настройках по умолчанию: опрос Remnawave раз в 15 секунд, мониторинг и сценарии разбирают каждый
 * снимок. Нода пропадает — когда открылось событие, когда изменено имя Host; нода вернулась — когда событие закрыто
 * и Host вернули. Секунды — от первого снимка, где нода уже не на связи.
 */
describe('Цепочка «нода упала → событие → Host → возврат» при настройках по умолчанию', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });
  it('событие через 45 с, имя Host — через 60 с; после возвращения ноды событие и Host — через 45 с', async () => {
    const t0 = Date.parse('2026-10-13T10:00:00Z');
    vi.useFakeTimers({ now: t0, toFake: ['Date'] });
    const node = {
      uuid: '11111111-1111-4111-8111-111111111111',
      name: 'Нидерланды - 1',
      address: '45.12.8.77',
      isConnected: false,
      isDisabled: false,
      usersOnline: null as number | null,
      cpuCount: 4,
      loadAverage: [] as number[],
      memoryTotalBytes: null,
      memoryUsedBytes: null,
    };
    const status = () => ({
      connected: true,
      domain: 'panel.test',
      error: null,
      checkedAt: new Date().toISOString(),
      nodes: [{ ...node }],
    });
    // Общие для обоих: события ноды (как таблица incidents) и записи app_meta.
    type Row = { id: string; nodeUuid: string; kind: string; status: string; timeline: unknown[] };
    const incidents: Row[] = [];
    const meta = new Map<string, string>();
    const db = {
      query: {
        appMeta: {
          findFirst: async (args: { where: never }) => {
            const value = meta.get(new PgDialect().sqlToQuery(args.where).params[0] as string);
            return value === undefined ? undefined : { value };
          },
        },
      },
      insert: () => ({
        values: (v: { key: string; value: string }) => ({
          onConflictDoUpdate: async () => void meta.set(v.key, v.value),
        }),
      }),
      // Сценарии читают открытые события ноды SQL-запросом.
      execute: async () => ({
        rows: incidents
          .filter((i) => i.status !== 'resolved')
          .map((i) => ({ node_uuid: i.nodeUuid, kind: i.kind, diagnostics: null })),
      }),
    };
    const log: Array<[string, number]> = [];
    const since = () => (Date.now() - t0) / 1000;
    const repo = {
      list: async () => incidents.filter((i) => i.status !== 'resolved'),
      open: async (v: { nodeUuid: string; kind: string; timeline: unknown[] }) => {
        if (incidents.some((i) => i.nodeUuid === v.nodeUuid && i.kind === v.kind && i.status !== 'resolved'))
          return undefined;
        const row = { id: `inc-${incidents.length + 1}`, status: 'open', ...v };
        incidents.push(row);
        log.push([`событие ${v.kind}`, since()]);
        return { ...row, severity: 'crit' };
      },
      appendTimeline: async (id: string, e: unknown) => {
        incidents.find((i) => i.id === id)?.timeline.push(e);
        return { id, title: '' };
      },
      update: async (id: string, patch: { status?: string }) => {
        const row = incidents.find((i) => i.id === id);
        if (row && patch.status === 'resolved' && row.status !== 'resolved') {
          row.status = 'resolved';
          log.push([`закрыто ${row.kind}`, since()]);
        }
        return undefined;
      },
    };
    // Remnawave: Host ноды; PATCH меняет имя — засекаем изменение и возврат.
    let host: Record<string, unknown> = {
      uuid: 'host',
      nodes: [node.uuid],
      isDisabled: false,
      remark: '🇳🇱 Нидерланды',
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        if (init?.method === 'PATCH') {
          const body = JSON.parse(String(init.body));
          host = { ...host, ...body };
          log.push([String(body.remark).includes('⚠️') ? 'Host изменён' : 'Host возвращён', since()]);
          return new Response(JSON.stringify({ response: host }));
        }
        return new Response(JSON.stringify({ response: [host] }));
      }),
    );
    const cfg = { ...MONITORING_DEFAULTS, checkHostOnDrop: false };
    const monitor = new FleetMonitorJob(
      db as never,
      { status: async () => status() } as never,
      { get: async () => cfg } as never,
      repo as never,
      { push: async () => undefined } as never,
      { checkNode: vi.fn() } as never,
      { incidentsTick: () => undefined } as never,
    );
    const rules = [
      {
        id: '22222222-2222-4222-8222-222222222222',
        name: 'Критическое падение онлайна',
        enabled: true,
        scope: 'all',
        nodes: [],
        hostBindings: [],
        trigger: 'offline',
        conditions: [],
        conditionMode: 'all',
        holdMinutes: 1,
        actions: ['rename_host'],
        renameMode: 'append',
        renameText: '⚠️',
        autoRestore: true,
        cooldownMinutes: 30,
      },
    ];
    const store = {
      scope: () => 'scope',
      list: async () => rules,
      read: async (k: string) => (meta.has(k) ? JSON.parse(meta.get(k) as string) : null),
      write: async (k: string, v: unknown) => void meta.set(k, JSON.stringify(v)),
      remove: async (k: string) => void meta.delete(k),
      addRun: async () => undefined,
    };
    const scenarios = new ScenariosJob(
      db as never,
      store as never,
      { status: async () => status() } as never,
      { credentials: async () => ({ domain: 'panel.test', apiKey: 'secret' }) } as never,
      { get: async () => cfg } as never,
      { checkNode: vi.fn() } as never,
      { append: vi.fn() } as never,
      { push: vi.fn(), telegramOutlook: async () => 'send' } as never,
      undefined,
      { observe: async (_s: string, _c: unknown, action: () => Promise<unknown>) => action() } as never,
      { forNode: async () => null, note: async () => undefined } as never,
    );
    // Опрос раз в 15 секунд: каждый снимок разбирают мониторинг и сценарии. Нода вернётся на 120-й секунде.
    for (let t = 0; t <= 240; t += 15) {
      vi.setSystemTime(t0 + t * 1000);
      node.isConnected = t >= 120;
      await monitor.run();
      await scenarios.run();
      await scenarios.idle();
    }
    expect(log).toEqual([
      ['событие node_down', 45],
      ['Host изменён', 60],
      ['закрыто node_down', 165],
      ['Host возвращён', 165],
    ]);
  });
});
