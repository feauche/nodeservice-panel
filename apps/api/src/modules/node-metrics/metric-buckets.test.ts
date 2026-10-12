import type { NodeMetricPoint } from '@nodeservice/shared';
import { describe, expect, it } from 'vitest';

import { bridgeSingleGaps, fillPoint, fleetSeries, isMissing } from './metric-buckets.js';

const p = (t: number, v: Partial<NodeMetricPoint> = {}): NodeMetricPoint => ({
  t,
  cpu: null,
  ram: null,
  load: null,
  rx: null,
  tx: null,
  online: null,
  ...v,
});

describe('корзины замеров', () => {
  it('одиночный пропуск дорисовывается средним соседей, края и перерыв из двух корзин — нет', () => {
    const points = [
      p(0),
      p(1, { rx: 10, online: 4 }),
      p(2),
      p(3, { rx: 20, online: 6, ram: 30 }),
      p(4),
      p(5),
      p(6, { rx: 1, online: 1 }),
      p(7),
    ];
    const out = bridgeSingleGaps(points, fillPoint);
    expect(out.map((x) => x.rx)).toEqual([null, 10, 15, 20, null, null, 1, null]);
    // Память известна только у одного соседа — берём её.
    expect(out[2]).toMatchObject({ online: 5, ram: 30 });
  });

  it('выключенная нода (онлайн 0) — это замер, а не пропуск', () => {
    expect(isMissing(p(0, { online: 0 }))).toBe(false);
    expect(isMissing(p(0))).toBe(true);
  });

  it('парк: сумма по приславшим, среднее памяти без выключенных, нод на связи', () => {
    const fleet = fleetSeries(
      [
        { uuid: 'a', points: [p(0, { online: 10, rx: 100, tx: 90, ram: 40 }), p(60_000)] },
        { uuid: 'b', points: [p(0, { online: 0, rx: 0, tx: 0 }), p(60_000, { online: 2 })] },
      ],
      new Map([
        ['a', new Map([[0, 1]])],
        [
          'b',
          new Map([
            [0, 0],
            [60_000, 0.4],
          ]),
        ],
      ]),
    );
    expect(fleet[0]).toEqual({
      t: 0,
      online: 10,
      rx: 100,
      tx: 90,
      ram: 40,
      load: null,
      cpu: null,
      up: 1,
      nodes: 2,
    });
    // Трафика не прислал никто — не «0», а «не известно».
    expect(fleet[1]).toMatchObject({ online: 2, rx: null, tx: null, up: 0, nodes: 1 });
  });
});
