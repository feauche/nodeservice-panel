import { MONITORING_DEFAULTS } from '@nodeservice/shared';
import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it, vi } from 'vitest';
import { FleetMonitorJob } from './fleet-monitor.job.js';

describe('Пороги ресурсов ноды', () => {
  async function run(loadWarningPerCore: number | null, memoryWarningPercent: number | null, enabled = true) {
    const open = vi.fn(async () => null);
    const db = {
      query: { appMeta: { findFirst: async () => null } },
      insert: () => ({ values: () => ({ onConflictDoUpdate: async () => undefined }) }),
    };
    const cfg = {
      ...MONITORING_DEFAULTS,
      enabled: true,
      cpuEnabled: enabled,
      memoryEnabled: enabled,
      loadPerCore: 1.5,
      memoryPercent: 90,
      resourceDurationMinutes: 0,
    };
    const node = {
      uuid: 'node',
      name: 'Нода',
      isDisabled: false,
      isConnected: true,
      usersOnline: null,
      // За минуту — 5,6 на 4 ядра: 1,4 на ядро — ниже общего порога 1,5 (как в строке ноды).
      cpuCount: 4,
      loadAverage: [5.6, 5.2, 4.8],
      memoryTotalBytes: 100,
      memoryUsedBytes: 80,
    };
    const job = new FleetMonitorJob(
      db as never,
      {
        status: async () => ({
          connected: true,
          domain: 'panel',
          checkedAt: new Date().toISOString(),
          nodes: [node],
        }),
      } as never,
      { get: async () => cfg } as never,
      { list: async () => [], open } as never,
      {} as never,
      {} as never,
      { incidentsTick: () => undefined } as never,
      { forMonitoring: async () => ({ loadWarningPerCore, memoryWarningPercent }) } as never,
    );
    await job.run();
    return open;
  }
  it('свои пороги нагрузки на ядро и памяти создают события', async () => {
    const open = await run(1, 70);
    expect(open.mock.calls.map(([i]) => i.kind)).toEqual(['cpu_high', 'mem_high']);
  });
  it('пустые поля наследуют общие пороги', async () => {
    expect(await run(null, null)).not.toHaveBeenCalled();
  });
  it('индивидуальный порог не включает выключенные предупреждения', async () => {
    expect(await run(1, 70, false)).not.toHaveBeenCalled();
  });
  it('нагрузка на ядро — то же число, что в строке ноды (средняя за минуту), текстом с запятой', async () => {
    const open = await run(1, null);
    const call = open.mock.calls.find(([i]) => i.kind === 'cpu_high')?.[0] as {
      title: string;
      detail: string;
    };
    expect(call.title).toBe('Высокая нагрузка на процессор');
    expect(call.detail).toContain('Нагрузка на ядро — 1,4 (порог 1,0, ядер: 4) держится дольше 0 мин');
  });
  it('событие о нагрузке закрывается, только когда нагрузка ниже порога с запасом держится столько же минут', async () => {
    const rows = new Map<string, string>();
    const db = {
      query: {
        appMeta: {
          findFirst: async (args: { where: never }) => {
            const value = rows.get(new PgDialect().sqlToQuery(args.where).params[0] as string);
            return value === undefined ? undefined : { value };
          },
        },
      },
      insert: () => ({
        values: (v: { key: string; value: string }) => ({
          onConflictDoUpdate: async () => {
            rows.set(v.key, v.value);
          },
        }),
      }),
    };
    const cfg = { ...MONITORING_DEFAULTS, enabled: true, loadPerCore: 1.5, resourceDurationMinutes: 2 };
    let at = Date.parse('2026-10-13T10:00:00Z'),
      load = 4;
    const update = vi.fn(async () => undefined);
    const job = new FleetMonitorJob(
      db as never,
      {
        status: async () => ({
          connected: true,
          domain: 'panel',
          checkedAt: new Date(at).toISOString(),
          nodes: [
            {
              uuid: 'node',
              name: 'Нода',
              isDisabled: false,
              isConnected: true,
              usersOnline: null,
              cpuCount: 4,
              loadAverage: [load, load, load],
              memoryTotalBytes: null,
              memoryUsedBytes: null,
            },
          ],
        }),
      } as never,
      { get: async () => cfg } as never,
      {
        list: async () => [{ id: 'i1', nodeUuid: 'node', kind: 'cpu_high', timeline: [] }],
        open: async () => null,
        appendTimeline: async () => ({ id: 'i1', title: '' }),
        update,
      } as never,
      { push: async () => undefined } as never,
      {} as never,
      { incidentsTick: () => undefined } as never,
    );
    vi.useFakeTimers({ now: at });
    try {
      const step = async (seconds: number, perCore: number) => {
        at += seconds * 1000;
        vi.setSystemTime(at);
        load = perCore * 4;
        await job.run();
      };
      await step(0, 1); // ниже порога с запасом: отсчёт пошёл
      await step(60, 1); // минута — рано
      expect(update).not.toHaveBeenCalled();
      await step(30, 1.6); // снова выше порога — отсчёт сбрасывается
      await step(30, 1);
      await step(90, 1); // полторы минуты после сброса — рано
      expect(update).not.toHaveBeenCalled();
      await step(40, 1); // больше двух минут подряд ниже — закрываем
      expect(update).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });
  it('смена IP при блокировке: строки в событии, проверка нового адреса, закрытие по обычному для часа онлайну', async () => {
    const rows = new Map<string, string>();
    const db = {
      query: {
        appMeta: {
          findFirst: async (args: { where: never }) => {
            const value = rows.get(new PgDialect().sqlToQuery(args.where).params[0] as string);
            return value === undefined ? undefined : { value };
          },
        },
      },
      insert: () => ({
        values: (v: { key: string; value: string }) => ({
          onConflictDoUpdate: async () => {
            rows.set(v.key, v.value);
          },
        }),
      }),
    };
    const cfg = { ...MONITORING_DEFAULTS, enabled: true };
    let at = Date.parse('2026-10-12T16:58:00Z');
    const node = {
      uuid: 'nl1',
      name: 'Нидерланды - 1',
      address: '45.12.8.77',
      isDisabled: false,
      isConnected: true,
      usersOnline: 30,
      cpuCount: 4,
      loadAverage: [0.5, 0.5, 0.5],
      memoryTotalBytes: null,
      memoryUsedBytes: null,
    };
    // Падение уже подтверждено днём: онлайн до сбоя 512, событие о блокировке открыто, адрес был прежний.
    const scope = '320e00e73a7d24a9'; // sha256('panel').slice(0, 16)
    rows.set(
      `monitor.history.${scope}.nl1`,
      JSON.stringify({
        samples: [],
        lastAt: at - 15_000,
        dropSeen: 4,
        baseline: 512,
        recovered: 0,
        downSeen: 0,
        cpuSince: null,
        memSince: null,
        address: '94.183.152.24',
      }),
    );
    const incident = {
      id: 'inc',
      nodeUuid: 'nl1',
      kind: 'node_blocked',
      status: 'open',
      timeline: [] as Array<Record<string, unknown>>,
    };
    const report = (address: string) => ({
      verdict: 'reachable',
      checkedAt: new Date(at).toISOString(),
      target: `${address}:5492`,
      link: 'https://check-host.net/check-report/abc1',
      observations: [
        { node: 'ru1', country: 'ru', city: 'Москва', state: 'ok', error: null },
        { node: 'de1', country: 'de', city: 'Франкфурт', state: 'ok', error: null },
      ],
      error: null,
    });
    const checkNode = vi.fn(async (address: string) => report(address));
    const update = vi.fn(async (_id: string, patch: { status?: string }) => {
      if (patch.status) incident.status = patch.status;
      return undefined;
    });
    const pushed: Array<{ title: string; body: string }> = [];
    const job = new FleetMonitorJob(
      db as never,
      {
        status: async () => ({
          connected: true,
          domain: 'panel',
          checkedAt: new Date(at).toISOString(),
          nodes: [{ ...node }],
        }),
      } as never,
      { get: async () => cfg } as never,
      {
        list: async () => (incident.status === 'open' ? [incident] : []),
        open: async () => null,
        appendTimeline: async (_id: string, e: Record<string, unknown>) => {
          incident.timeline.push(e);
          return { id: 'inc', title: '' };
        },
        update,
      } as never,
      { push: async (n: { title: string; body: string }) => void pushed.push(n) } as never,
      { checkNode } as never,
      { incidentsTick: () => undefined } as never,
      undefined,
      // Ночью у ноды обычно 150–300: дневные 512 не вернутся, закрываем по обычному уровню.
      { typicalOnline: async () => ({ low: 150, high: 300 }) } as never,
    );
    vi.useFakeTimers({ now: at, toFake: ['Date'] });
    try {
      await job.run();
      // Новый адрес — строка в событии и сразу проверка порта на нём.
      await vi.waitFor(() => expect(incident.timeline.some((e) => e.step === 'port')).toBe(true));
      expect(checkNode).toHaveBeenCalledWith('45.12.8.77', 5492, undefined);
      for (const online of [180, 190, 200, 210]) {
        at += 15_000;
        vi.setSystemTime(at);
        node.usersOnline = online;
        await job.run();
      }
      expect(incident.status).toBe('resolved');
      expect(incident.timeline.map((e) => [e.step, e.tone, e.action])).toEqual([
        ['address', 'change', 'Адрес ноды изменён в Remnawave'],
        ['port', 'ok', 'Порт 5492 на новом адресе доступен'],
        ['online', 'wait', 'Онлайн возвращается: 180'],
        ['close', 'ok', 'Нода снова работает: адрес сменили, порт доступен, онлайн 210 (обычно около 225).'],
      ]);
      expect(incident.timeline[0]).toMatchObject({ detail: '94.183.152.24 → 45.12.8.77' });
      expect(incident.timeline[1]).toMatchObject({
        detail: 'Из РФ 1 из 1, из других стран 1 из 1.',
        link: { label: 'Отчёт Check-Host', href: 'https://check-host.net/check-report/abc1' },
      });
      expect(incident.timeline[2]).toMatchObject({
        detail:
          'Обычно в это время около 225. Закрою событие сам, когда онлайн около минуты продержится не ниже 158.',
      });
      expect(pushed.at(-1)).toMatchObject({ title: 'Восстановление · Нидерланды - 1' });
    } finally {
      vi.useRealTimers();
    }
  });
});
