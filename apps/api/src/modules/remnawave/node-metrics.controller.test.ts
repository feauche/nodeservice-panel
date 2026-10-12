import { PgDialect } from 'drizzle-orm/pg-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NodeMetricsController, NodeMetricsService } from './node-metrics.controller.js';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
describe('node metric history', () => {
  it('persists a stale snapshot at its original minute without forcing an external poll', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-12T04:00:00Z'));
    const execute = vi.fn().mockResolvedValue({ rows: [] });
    const syncQuiet = vi.fn();
    const status = vi.fn().mockResolvedValue({
      domain: 'panel.example',
      checkedAt: '2026-10-12T03:00:23Z',
      error: null,
      nodes: [{ uuid: 'node', isConnected: true, isDisabled: false, usersOnline: 42, rxBytesPerSec: 0 }],
    });
    const service = new NodeMetricsService(
      { execute } as never,
      { domain: async () => 'panel.example' } as never,
      { status, syncQuiet } as never,
    );
    await service.collect();
    vi.setSystemTime(new Date('2026-10-12T04:01:00Z'));
    await service.collect();
    expect(syncQuiet).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledTimes(2);
    const dialect = new PgDialect();
    const first = dialect.sqlToQuery(execute.mock.calls[0][0]);
    const repeated = dialect.sqlToQuery(execute.mock.calls[2][0]);
    expect(first.sql).toContain('ON CONFLICT DO NOTHING');
    expect(repeated.params).toEqual(first.params);
    expect(first.params).toEqual([
      'panel.example',
      'node',
      '2026-10-12T03:00:00.000Z',
      JSON.stringify({ cpu: null, ram: null, load: null, rx: 0, tx: null, online: 42 }),
    ]);
  });
  it.each([
    { checkedAt: null, error: null },
    { checkedAt: '2026-10-12T03:00:00Z', error: 'API unavailable' },
  ])('does not invent samples for an unmeasured or failed snapshot: %j', async (snapshot) => {
    const execute = vi.fn();
    const syncQuiet = vi.fn();
    const service = new NodeMetricsService(
      { execute } as never,
      { domain: async () => 'panel.example' } as never,
      { status: async () => ({ domain: 'panel.example', nodes: [], ...snapshot }), syncQuiet } as never,
    );
    await service.collect();
    expect(execute).not.toHaveBeenCalled();
    expect(syncQuiet).not.toHaveBeenCalled();
  });
  it('fills missing/offline minutes with null, preserves measured zero and caches aggregation', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-11T08:02:00Z'));
    const t = Date.parse('2026-10-11T08:00:00Z') / 1000;
    const execute = vi
      .fn()
      .mockResolvedValueOnce({ rows: [{ first: new Date(t * 1000) }] })
      .mockResolvedValueOnce({
        rows: [
          { uuid: 'node', t, rx: 0, ram: null },
          { uuid: 'node', t: t + 120, rx: 10, ram: 25 },
        ],
      });
    const fetcher = vi.fn(
      async () =>
        new Response(JSON.stringify({ response: { categories: [], sparklineData: [], series: [] } })),
    );
    vi.stubGlobal('fetch', fetcher);
    const service = new NodeMetricsService(
      { execute } as never,
      {
        domain: async () => 'panel.example',
        credentials: async () => ({ domain: 'panel.example', apiKey: 'secret' }),
      } as never,
      {} as never,
    );
    vi.spyOn(service, 'collect').mockResolvedValue();
    const result = await service.get(60, 7);
    expect(result.history[0].points.map((p) => p.rx)).toEqual([0, null, 10]);
    expect(result.history[0].points[0].ram).toBeNull();
    expect(result.history[0].points[1].t).toBe((t + 60) * 1000);
    await service.get(60, 7);
    expect(execute).toHaveBeenCalledTimes(2);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(JSON.stringify(result)).not.toContain('secret');
  });
  it('validates request ranges before querying storage or remote API', () => {
    const get = vi.fn();
    const controller = new NodeMetricsController({ get } as never, {} as never, {} as never, {} as never);
    expect(() => controller.get('129600', '90')).toThrow();
    expect(get).not.toHaveBeenCalled();
    controller.get('10080', '7');
    expect(get).toHaveBeenCalledWith(10080, 7);
  });
});
