import { MONITORING_DEFAULTS } from '@nodeservice/shared';
import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it, vi } from 'vitest';
import { FleetMonitorJob } from './fleet-monitor.job.js';

/** Наблюдение за нодой, которая лежит, пока владелец её обслуживает (0.106.0). */
function setup() {
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
  let stamp = Date.now() - 60_000;
  const node = {
    uuid: 'node',
    name: 'Германия - 1',
    address: '1.2.3.4',
    isDisabled: false,
    isConnected: false,
  };
  const remna = {
    status: async () => ({
      connected: true,
      domain: 'panel',
      checkedAt: new Date(stamp).toISOString(),
      nodes: [node],
    }),
  };
  const open = vi.fn(async () => undefined);
  const repo = { list: async () => [], open };
  const onMaintenance = new Set<string>(['node']);
  const maintenance = {
    active: vi.fn(async () => new Map([...onMaintenance].map((u) => [u, { nodeUuid: u }]))),
  };
  const checkNode = vi.fn();
  const cfg = { ...MONITORING_DEFAULTS, enabled: true, confirmSamples: 4, checkHostEnabled: true };
  const job = new FleetMonitorJob(
    db as never,
    remna as never,
    { get: async () => cfg } as never,
    repo as never,
    { push: vi.fn() } as never,
    { checkNode } as never,
    { incidentsTick: () => undefined } as never,
    undefined,
    undefined,
    maintenance as never,
  );
  const poll = async (times: number) => {
    for (let i = 0; i < times; i++) {
      stamp += 15_000;
      await job.run();
    }
  };
  return { job, poll, open, onMaintenance, rows, checkNode, node };
}

describe('Наблюдение за нодой на обслуживании', () => {
  it('нода лежит всё обслуживание — событий нет, счётчик подтверждений не копится', async () => {
    const t = setup();
    await t.poll(10);
    expect(t.open).not.toHaveBeenCalled();
    const st = JSON.parse([...t.rows.values()][0] ?? '{}');
    expect(st.downSeen).toBe(0);
    expect(st.address).toBe('1.2.3.4');
  });

  it('после окончания нода проходит обычное подтверждение заново, а не получает тревогу сразу', async () => {
    const t = setup();
    await t.poll(6);
    t.onMaintenance.clear();
    await t.poll(3);
    expect(t.open).not.toHaveBeenCalled();
    await t.poll(1);
    expect(t.open).toHaveBeenCalledTimes(1);
    expect(t.open.mock.calls[0]?.[0]).toMatchObject({ kind: 'node_down', nodeUuid: 'node' });
  });

  it('фоновая проверка падения, закончившаяся во время обслуживания, событие не открывает', async () => {
    const t = setup();
    await (t.job as unknown as { open: (...a: unknown[]) => Promise<void> }).open(
      t.node,
      'server_down',
      'Падение онлайна · TCP-порт недоступен',
      '',
    );
    expect(t.open).not.toHaveBeenCalled();
  });

  it('плановая проверка TCP ноду на обслуживании пропускает', async () => {
    const t = setup();
    await t.job.runScheduledTcp();
    expect(t.checkNode).not.toHaveBeenCalled();
  });
});
