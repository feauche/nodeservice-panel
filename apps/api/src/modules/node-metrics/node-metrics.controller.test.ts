import { PgDialect } from 'drizzle-orm/pg-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NodeMetricsController, NodeMetricsService } from './node-metrics.controller.js';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
describe('node metric history', () => {
  it('пишет снимок с его точным временем, не дёргая Remnawave; нода не на связи даёт ноль трафика', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-12T04:00:00Z'));
    const execute = vi.fn().mockResolvedValue({ rows: [] });
    const syncQuiet = vi.fn();
    const status = vi.fn().mockResolvedValue({
      domain: 'panel.example',
      checkedAt: '2026-10-12T03:00:23Z',
      error: null,
      nodes: [
        { uuid: 'node', isConnected: true, isDisabled: false, usersOnline: 42, rxBytesPerSec: 0 },
        { uuid: 'off', isConnected: true, isDisabled: true, usersOnline: null, rxBytesPerSec: 9 },
      ],
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
    // Тот же снимок повторно не пишется: вставка и очистка старых замеров — только при первом сборе.
    expect(execute).toHaveBeenCalledTimes(2);
    const dialect = new PgDialect();
    const first = dialect.sqlToQuery(execute.mock.calls[0][0]);
    expect(first.sql).toContain('ON CONFLICT DO NOTHING');
    expect(first.params).toEqual([
      'panel.example',
      'node',
      '2026-10-12T03:00:23.000Z',
      JSON.stringify({ cpu: null, ram: null, load: null, rx: 0, tx: null, online: 42, up: 1 }),
      'panel.example',
      'off',
      '2026-10-12T03:00:23.000Z',
      JSON.stringify({ cpu: null, ram: null, load: null, rx: 0, tx: 0, online: 0, up: 0 }),
    ]);
    expect(dialect.sqlToQuery(execute.mock.calls[1][0]).sql).toContain('DELETE');
    // Новый снимок пишется сразу, а очистка ждёт 10 минут с прошлой.
    status.mockResolvedValueOnce({
      domain: 'panel.example',
      checkedAt: '2026-10-12T04:01:05Z',
      error: null,
      nodes: [{ uuid: 'node', isConnected: true, isDisabled: false, usersOnline: 40, rxBytesPerSec: 0 }],
    });
    await service.collect();
    expect(execute).toHaveBeenCalledTimes(3);
    expect(dialect.sqlToQuery(execute.mock.calls[2][0]).sql).toContain('INSERT');
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
  it('одиночный пропуск дорисовывает, долгий оставляет пустым; сумма парка — по нодам, приславшим замер', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-11T08:06:00Z'));
    const t = Date.parse('2026-10-11T08:00:00Z') / 1000;
    const execute = vi
      .fn()
      .mockResolvedValueOnce({ rows: [{ first: new Date(t * 1000) }] })
      .mockResolvedValueOnce({
        rows: [
          { uuid: 'a', t, rx: 0, ram: null, online: 5, up: 1 },
          // 08:01 у «a» пропущена: одиночный пропуск.
          { uuid: 'a', t: t + 120, rx: 10, ram: 25, online: 7, up: 1 },
          // 08:03 и 08:04 пропущены: настоящий перерыв.
          { uuid: 'a', t: t + 300, rx: 20, ram: 30, online: 9, up: 1 },
          { uuid: 'b', t: t + 120, rx: 4, ram: 50, online: 3, up: 1 },
        ],
      });
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    const service = new NodeMetricsService(
      { execute } as never,
      { domain: async () => 'panel.example' } as never,
      {} as never,
    );
    vi.spyOn(service, 'collect').mockResolvedValue();
    vi.spyOn(service as never, 'onlineTypical').mockResolvedValue(null as never);
    const result = await service.get(60);
    const a = result.history.find((n) => n.uuid === 'a');
    expect(a?.points.map((p) => p.rx)).toEqual([0, 5, 10, null, null, 20]);
    expect(a?.points[1]?.t).toBe((t + 60) * 1000);
    expect(a?.points[0]?.ram).toBeNull();
    // 08:02: обе ноды — сумма; 08:03: «a» молчит, «b» уже кончилась — корзина пустая.
    const at = (sec: number) => result.fleet.find((p) => p.t === (t + sec) * 1000);
    expect(at(120)).toMatchObject({ rx: 14, online: 10, ram: 37.5, up: 2, nodes: 2 });
    expect(at(180)).toMatchObject({ rx: null, online: null, nodes: 0 });
    expect(at(60)).toMatchObject({ rx: 5, online: 6, nodes: 1 });
    // Трафик за 30 дней больше не загружается при каждом открытии обзора.
    expect(fetcher).not.toHaveBeenCalled();
    await service.get(60);
    expect(execute).toHaveBeenCalledTimes(2);
  });
  it.each([60, 300])(
    'не создаёт ложный разрыв в текущем незавершённом интервале %sс',
    async (pollSeconds) => {
      vi.useFakeTimers();
      const t = Date.parse('2026-10-11T08:00:00Z') / 1000;
      vi.setSystemTime(new Date((t + pollSeconds) * 1000));
      const execute = vi
        .fn()
        .mockResolvedValueOnce({ rows: [{ first: new Date(t * 1000) }] })
        .mockResolvedValueOnce({ rows: [{ uuid: 'node', t, rx: 0, online: 0 }] });
      const service = new NodeMetricsService(
        { execute } as never,
        { domain: async () => 'panel.example' } as never,
        {} as never,
        { get: async () => ({ pollSeconds }) } as never,
      );
      const result = await service.localHistory(60);
      expect(result.history[0].points).toHaveLength(1);
      expect(result.history[0].points[0].rx).toBe(0);
      expect(new PgDialect().sqlToQuery(execute.mock.calls[1][0]).params).toContain(pollSeconds);
    },
  );
  it('validates request ranges before querying storage or remote API', () => {
    const get = vi.fn();
    const stats = { get: vi.fn() };
    const controller = new NodeMetricsController(
      { get } as never,
      {} as never,
      {} as never,
      {} as never,
      stats as never,
    );
    expect(() => controller.get('129600')).toThrow();
    expect(get).not.toHaveBeenCalled();
    controller.get('10080');
    expect(get).toHaveBeenCalledWith(10080);
    expect(() => controller.statsGet('90')).toThrow();
    controller.statsGet('7');
    expect(stats.get).toHaveBeenCalledWith(7);
  });
});
