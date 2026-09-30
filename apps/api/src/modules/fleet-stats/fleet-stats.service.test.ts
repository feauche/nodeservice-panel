import { FLEET_STATS_PERIOD_SPEC, fleetStatsSchema, VM_METRIC_NAMES } from '@nodeservice/shared';
import { describe, expect, it } from 'vitest';

import { billingPayments, incidents, servers } from '../../infra/db/schema/index.js';
import type { VmMatrixSeries } from '../metrics/vm-reader.service.js';
import { FleetStatsService } from './fleet-stats.service.js';

/**
 * Известный ряд: агент пишет скорость сети в БАЙТАХ в секунду. Два сервера весь период ровно принимают и
 * отдают вместе 12,5 МБ/с — это 100 Мбит/с и 1,08 ТБ за сутки.
 */
const RATE = {
  rx: { 'srv-a': 5_000_000, 'srv-b': 2_500_000 },
  tx: { 'srv-a': 3_000_000, 'srv-b': 2_000_000 },
} as const;
const RX = RATE.rx['srv-a'] + RATE.rx['srv-b'];
const TX = RATE.tx['srv-a'] + RATE.tx['srv-b'];
/** Прошлые сутки — вдвое тише. */
const PREV = 0.5;
/** В одном шаге графика скорость вдвое выше — это пик. */
const PEAK_STEP = 7;

const spec = FLEET_STATS_PERIOD_SPEC.day;
const M = VM_METRIC_NAMES;
const dirOf = (q: string): 'rx' | 'tx' => (q.includes(M.netRxBps) ? 'rx' : 'tx');
const perServer = (dir: 'rx' | 'tx', mult: number, t: number): VmMatrixSeries[] =>
  Object.entries(RATE[dir]).map(([id, rate]) => ({ labels: { server_id: id }, points: [[t, rate * mult]] }));

/**
 * Хранилище метрик «как настоящее»: integrate() от ряда в байт/с — байты за окно, avg_over_time() — байт/с.
 * Остальные запросы (нагрузка, онлайн) отвечают пусто.
 */
const vm = {
  async query(q: string): Promise<VmMatrixSeries[]> {
    const t = Math.floor(Date.now() / 1000);
    if (!q.includes('integrate(')) return [];
    const dir = dirOf(q);
    if (q.includes('offset'))
      return [{ labels: {}, points: [[t, (dir === 'rx' ? RX : TX) * PREV * spec.seconds]] }];
    return perServer(dir, spec.seconds, t);
  },
  async queryRange(q: string, start: number, end: number, step: number): Promise<VmMatrixSeries[]> {
    const ts: number[] = [];
    for (let t = start; t <= end; t += step) ts.push(t);
    if (q.includes('integrate('))
      return [{ labels: {}, points: ts.map((t) => [t, (RX + TX) * spec.bucket] as [number, number]) }];
    if (q.includes('avg_over_time(') && (q.includes(M.netRxBps) || q.includes(M.netTxBps))) {
      const rate = dirOf(q) === 'rx' ? RX : TX;
      return [
        {
          labels: {},
          points: ts.map((t, i) => [t, i === PEAK_STEP ? rate * 2 : rate] as [number, number]),
        },
      ];
    }
    return [];
  },
};

/** База: два сервера, инцидентов нет, за период оплачено 5 400 ₽. */
const db = {
  select: () => ({
    from: (table: unknown) => {
      const rows =
        table === servers
          ? [
              { id: 'srv-a', name: 'DE-1' },
              { id: 'srv-b', name: 'NL-2' },
            ]
          : table === incidents
            ? []
            : table === billingPayments
              ? [{ rub: 540_000 }]
              : [];
      const query = {
        where: () => query,
        // biome-ignore lint/suspicious/noThenProperty: запрос drizzle ждут через await — повторяем это в подделке
        then: <T>(ok: (rows: unknown[]) => T) => Promise.resolve(rows).then(ok),
      };
      return query;
    },
  }),
};
const remnawave = { status: async () => ({ stats: { users: { total: 100 } } }) };

describe('статистика парка — единицы трафика и скорости', () => {
  const service = new FleetStatsService(db as never, vm as never, remnawave as never);

  it('известный ряд в байт/с: объёмы — в байтах, скорости — в бит/с, цена терабайта — по настоящему объёму', async () => {
    const st = fleetStatsSchema.parse(await service.stats('day'));
    expect(st.vmOk).toBe(true);

    // 12,5 МБ/с за сутки — 1,08 ТБ (а не 135 ГБ).
    expect(st.traffic.rxBytes).toBe(RX * 86_400);
    expect(st.traffic.txBytes).toBe(TX * 86_400);
    expect((st.traffic.rxBytes ?? 0) + (st.traffic.txBytes ?? 0)).toBe(1.08e12);
    expect(st.traffic.prevTotalBytes).toBe(0.54e12);
    expect(st.traffic.buckets.length).toBeGreaterThan(0);
    // За час при 12,5 МБ/с — 45 ГБ.
    for (const b of st.traffic.buckets) expect(b.bytes).toBe(45e9);

    // Скорость — в бит/с, как написано в контракте и как её подписывает страница: 12,5 МБ/с = 100 Мбит/с.
    expect(st.traffic.speed.length).toBeGreaterThan(PEAK_STEP);
    expect(st.traffic.speed[0]).toMatchObject({ rx: RX * 8, tx: TX * 8 });
    expect(st.traffic.peakBps).toBe(200e6);
    expect(st.traffic.peakAt).toBe(st.traffic.speed[PEAK_STEP]?.at);
    const n = st.traffic.speed.length;
    expect(st.traffic.avgBps).toBeCloseTo((100e6 * (n + 1)) / n, 3);

    // По серверам: 8 МБ/с и 4,5 МБ/с за сутки.
    expect(st.servers.map((s) => [s.name, s.trafficBytes, s.sharePct])).toEqual([
      ['DE-1', 8_000_000 * 86_400, 64],
      ['NL-2', 4_500_000 * 86_400, 36],
    ]);

    // 5 400 ₽ на 1,08 ТБ — 5 000 ₽ за терабайт (а не 40 000 ₽).
    expect(st.cost.spentRubMinor).toBe(540_000);
    expect(st.cost.perTbRubMinor).toBe(500_000);
    expect(st.cost.perUserRubMinor).toBe(5_400);
  });
});
