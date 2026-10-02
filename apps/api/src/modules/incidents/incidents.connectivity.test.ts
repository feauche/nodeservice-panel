import { describe, expect, it, vi } from 'vitest';

import type { ServerRow } from '../../infra/db/schema/index.js';
import { IncidentsService } from './incidents.service.js';
import type { CountryReachResult } from './node-block-check.service.js';

type ConnectivityResult = 'checked' | 'panel_blind' | 'coverage_blind';

function make(reach: CountryReachResult) {
  const findOpen = vi.fn(async () => undefined);
  const stub = {} as never;
  const service = new IncidentsService(
    { findOpen } as never,
    stub,
    stub,
    stub,
    stub,
    stub,
    stub,
    stub,
    stub,
    stub,
    stub,
    stub,
    stub,
    stub,
  );
  const openIncident = vi.fn(async () => undefined);
  const evalBinary = vi.fn(async () => undefined);
  const evalPartialReach = vi.fn(async () => undefined);
  Object.assign(service as unknown as Record<string, unknown>, {
    hostAnswers: async () => false,
    countryReachCached: async () => reach,
    evalPartialReach,
    evalBinary,
    openIncident,
    paymentWindowFor: async () => ({ overdue: [], dueSoon: [], paying: 0 }),
    fleetTrouble: async () => ({ nodes: 0, linkedNodes: 0, servers: 0 }),
  });
  const server = {
    id: 's1',
    name: 'Финляндия - 1',
    host: '203.0.113.7',
    port: 5492,
    sshOk: false,
    agentStatus: 'offline',
    lastSshCheckAt: new Date(),
    lastSshOkAt: null,
  } as unknown as ServerRow;
  service.sshDownForMs = 0;
  const evaluate = () =>
    (
      service as unknown as {
        evalConnectivity(server: ServerRow, agentOff: boolean): Promise<ConnectivityResult>;
      }
    ).evalConnectivity(server, true);
  return { evaluate, findOpen, openIncident, evalBinary, evalPartialReach };
}

describe('достоверность диагноза связи сервера', () => {
  it('панель не вошла ни на один проверяющий сервер — не открывает инциденты по отдельным серверам', async () => {
    for (const blind of ['ssh', 'no_answer'] as const) {
      const { evaluate, openIncident, evalBinary } = make({ results: [], blind });
      await expect(evaluate()).resolves.toBe('panel_blind');
      expect(openIncident).not.toHaveBeenCalled();
      expect(evalBinary).not.toHaveBeenCalled();
    }
  });

  it('проверяющих нет — не объявляет сервер выключенным, но сохраняет точные сигналы агента и SSH', async () => {
    const { evaluate, openIncident, evalBinary } = make({ results: [], blind: 'no_probers' });
    await expect(evaluate()).resolves.toBe('coverage_blind');
    expect(openIncident).not.toHaveBeenCalled();
    expect(evalBinary).toHaveBeenCalledTimes(2);
  });

  it('проверяющий действительно дошёл до цели и увидел закрытый порт — сервер считается недоступным', async () => {
    const { evaluate, openIncident } = make({
      results: [{ from: 'Германия - 1', country: 'DE', open: false }],
      blind: null,
    });
    await expect(evaluate()).resolves.toBe('checked');
    expect(openIncident).not.toHaveBeenCalled();
    await expect(evaluate()).resolves.toBe('checked');
    expect(openIncident).toHaveBeenCalledTimes(1);
  });

  it('один изменившийся снимок не переключает диагноз и не закрывает прежнее дело', async () => {
    const reach: CountryReachResult = {
      results: [{ from: 'Германия - 1', country: 'DE', open: true }],
      blind: null,
    };
    const { evaluate, evalPartialReach } = make(reach);
    await evaluate();
    reach.results = [{ from: 'Германия - 1', country: 'DE', open: false }];
    await evaluate();
    expect(evalPartialReach).not.toHaveBeenCalled();
  });

  it('пороговые правила и автопочинка не ждут долгих сетевых перепроверок', async () => {
    const events: string[] = [];
    let release = () => undefined;
    const network = new Promise<void>((resolve) => {
      release = resolve;
    });
    const rows = ['s1', 's2'].map((id) => ({ id, agentStatus: 'offline', agentLastSeenAt: null }));
    const stub = {} as never;
    const service = new IncidentsService(
      stub,
      { list: async () => rows } as never,
      { get: async () => ({ cpuPct: 90, memPct: 90, diskPct: 90, forDurationMinutes: 5 }) } as never,
      stub,
      stub,
      { autoTick: async () => events.push('autofix') } as never,
      { remember: () => events.push('remember') } as never,
      stub,
      stub,
      stub,
      stub,
      stub,
      stub,
      { connectivityDown: async () => undefined, connectivityUp: async () => undefined } as never,
    );
    Object.assign(service as unknown as Record<string, unknown>, {
      evalNode: async (server: { id: string }) => events.push(`node:${server.id}`),
      evalThreshold: async (server: { id: string }) => events.push(`threshold:${server.id}`),
      evalConnectivity: async (server: { id: string }) => {
        events.push(`network:${server.id}`);
        await network;
        return 'checked';
      },
    });

    const run = service.evaluate({ cpu: new Map(), mem: new Map(), disk: new Map() });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(events.indexOf('autofix')).toBeGreaterThan(events.indexOf('threshold:s2'));
    expect(events.indexOf('autofix')).toBeLessThan(events.indexOf('network:s1'));
    release();
    await run;
  });
});
