import { MONITORING_DEFAULTS } from '@nodeservice/shared';
import { describe, expect, it, vi } from 'vitest';
import { FleetMonitorJob } from './fleet-monitor.job.js';

describe('Пороги ресурсов ноды', () => {
  async function run(cpuWarningPercent: number | null, memoryWarningPercent: number | null, enabled = true) {
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
      cpuPercent: 90,
      memoryPercent: 90,
      resourceDurationMinutes: 0,
    };
    const node = {
      uuid: 'node',
      name: 'Нода',
      isDisabled: false,
      isConnected: true,
      usersOnline: null,
      cpuPercent: 80,
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
      { forMonitoring: async () => ({ cpuWarningPercent, memoryWarningPercent }) } as never,
    );
    await job.run();
    return open;
  }
  it('индивидуальные CPU и RAM реально создают инциденты', async () => {
    const open = await run(75, 70);
    expect(open.mock.calls.map(([i]) => i.kind)).toEqual(['cpu_high', 'mem_high']);
  });
  it('пустые поля наследуют общие пороги', async () => {
    expect(await run(null, null)).not.toHaveBeenCalled();
  });
  it('индивидуальный порог не включает выключенные предупреждения', async () => {
    expect(await run(75, 70, false)).not.toHaveBeenCalled();
  });
});
