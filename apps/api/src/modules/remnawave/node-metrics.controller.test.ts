import { afterEach, describe, expect, it, vi } from 'vitest';
import { NodeMetricsController, NodeMetricsService } from './node-metrics.controller.js';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
describe('node metric history', () => {
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
    const controller = new NodeMetricsController({ get } as never, {} as never, {} as never);
    expect(() => controller.get('129600', '90')).toThrow();
    expect(get).not.toHaveBeenCalled();
    controller.get('10080', '7');
    expect(get).toHaveBeenCalledWith(10080, 7);
  });
});
