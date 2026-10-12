import { nodeMetricHistorySchema } from '@nodeservice/shared';
import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it, vi } from 'vitest';
import { NodeMetricHistoryService, parseMetricHistoryRange } from './node-metric-history.service.js';

const uuid = '11111111-1111-4111-8111-111111111111';
const from = '2026-10-12T03:00:00+06:00',
  to = '2026-10-12T03:03:00+06:00';
function fixture(rows: unknown[][] = [[], [], [], []]) {
  const execute = vi.fn();
  for (const r of [...rows, []]) execute.mockResolvedValueOnce({ rows: r });
  const domain = vi.fn().mockResolvedValue('panel.test');
  return {
    execute,
    domain,
    service: new NodeMetricHistoryService(
      { execute } as never,
      { domain } as never,
      {
        status: async () => ({ domain: 'panel.test', nodes: [{ uuid, name: 'Нода', address: '1.1.1.1' }] }),
      } as never,
    ),
  };
}
describe('combined persisted metric history', () => {
  it('returns a simultaneous fleet peak with its real timestamp and flags incomplete snapshots', async () => {
    const range = parseMetricHistoryRange(from, to, uuid);
    const { service, execute } = fixture([
      [],
      [],
      [],
      [],
      [{ peak: 140, minimum: 0, average: 80, samples: 3, peak_at: range.from, partial: true }],
    ]);
    const result = await service.get(range);
    expect(result.onlineSummary).toEqual({
      peak: 140,
      minimum: 0,
      average: 80,
      samples: 3,
      peakAt: range.from,
      partial: true,
    });
    const query = new PgDialect().sqlToQuery(execute.mock.calls[4][0]);
    expect(query.sql).toContain('GROUP BY sampled_at');
    expect(query.sql).toContain('WHERE known=');
    expect(query.sql).not.toContain('sum(online_max)');
  });
  it('requires timezone-qualified finite ordered bounded ranges and safe UUID node filters', () => {
    expect(parseMetricHistoryRange(from, to, uuid).from).toBe('2026-10-11T21:00:00.000Z');
    for (const [a, b, n, p] of [
      ['2026-10-12', '2026-10-13', '', '400'],
      [to, from, '', '400'],
      [from, to, "' OR true", '400'],
      [from, to, uuid, '601'],
      [from, '2026-12-12T03:00:00Z', '', '400'],
    ])
      expect(() => parseMetricHistoryRange(a, b, n, p)).toThrow();
  });
  it('preserves measured zero and extrema, inserts missing gaps and uses half-open SQL boundaries', async () => {
    const range = parseMetricHistoryRange(from, to, uuid);
    const { service, execute } = fixture([
      [{ first: range.from }],
      [
        {
          uuid,
          t: range.start / 1000,
          online_avg: 5,
          online_min: 0,
          online_max: 20,
          rx_avg: 0,
          rx_min: 0,
          rx_max: 0,
        },
      ],
      [],
      [],
    ]);
    const result = nodeMetricHistorySchema.parse(await service.get(range));
    expect(result.nodes[0].points.map((p) => p.rx)).toEqual([0, null, null]);
    expect(result.nodes[0].points[0]).toMatchObject({ online: 5, min: { online: 0 }, max: { online: 20 } });
    expect(result.nodes[0].points.every((p) => p.t >= range.start && p.t < range.end)).toBe(true);
    const query = new PgDialect().sqlToQuery(execute.mock.calls[1][0]);
    expect(query.sql).toContain('sampled_at <');
    expect(query.params).toContain(uuid);
    expect(query.params).toContain(range.to);
  });
  it('combines incident boundaries and actual check times, rejects malformed/out-of-range checks', async () => {
    const range = parseMetricHistoryRange(from, to);
    const check = (id: string, checkedAt: string) => ({
      key: `checkhost.node.${uuid}.${id}`,
      value: JSON.stringify({
        id,
        report: {
          checkedAt,
          target: '1.1.1.1:443',
          verdict: 'reachable',
          link: 'https://check-host.net/check-report/test',
          observations: [],
          error: null,
        },
      }),
    });
    const { service } = fixture([
      [],
      [],
      [
        {
          id: 'case',
          node_uuid: uuid,
          server_name: 'Нода',
          title: 'Падение',
          detail: 'Онлайн упал',
          type: 'incident_resolved',
          event_at: new Date(range.start + 120000),
        },
      ],
      [
        { key: 'bad', value: 'invalid' },
        check('inside', new Date(range.start + 60000).toISOString()),
        check('end', range.to),
      ],
    ]);
    const result = await service.get(range);
    expect(result.events.map((e) => e.id)).toEqual(['tcp:inside', 'case:incident_resolved']);
    expect(result.events[0].summary).toContain('Доступен');
  });
  it('bounds long ranges to600 points per node and validates connection identity after database reads', async () => {
    const range = parseMetricHistoryRange('2026-09-12T00:00:00Z', '2026-10-12T00:00:00Z', uuid, '600');
    const { service } = fixture();
    expect((await service.get(range)).nodes[0].points.length).toBeLessThanOrEqual(600);
    const changed = fixture();
    changed.domain.mockResolvedValueOnce('panel.test').mockResolvedValueOnce('new.test');
    await expect(changed.service.get(range)).rejects.toThrow('Подключение изменилось');
  });
  it('rejects stale or foreign selection before queries', async () => {
    const { service, execute } = fixture();
    await expect(
      service.get(parseMetricHistoryRange(from, to, '22222222-2222-4222-8222-222222222222')),
    ).rejects.toThrow('отсутствует');
    expect(execute).not.toHaveBeenCalled();
  });
});
