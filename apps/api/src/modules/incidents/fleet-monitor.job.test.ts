import { MONITORING_DEFAULTS } from '@nodeservice/shared';
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
      // Средняя за 15 минут — 4,8 на 4 ядра: 1,2 на ядро — ниже общего порога 1,5.
      cpuCount: 4,
      loadAverage: [6, 5.2, 4.8],
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
  it('нагрузка на ядро считается по средней за 15 минут и текстом с запятой', async () => {
    const open = await run(1, null);
    const call = open.mock.calls.find(([i]) => i.kind === 'cpu_high')?.[0] as {
      title: string;
      detail: string;
    };
    expect(call.title).toBe('Высокая нагрузка на процессор');
    expect(call.detail).toContain('Средняя нагрузка за 15 минут — 1,2 на ядро (порог 1,0, ядер: 4)');
  });
});
