import type { ServerMetricsResponse } from '@nodeservice/shared';
import { describe, expect, it } from 'vitest';

import { buildGeometry, chartMarkers, chartRange, pctSeries, spreadMarkers } from './analysis-chart-data';

const series = (over: Partial<ServerMetricsResponse['series']>): ServerMetricsResponse['series'] =>
  ({ ...over }) as ServerMetricsResponse['series'];

describe('chartRange', () => {
  it('свежий инцидент — час, старый — сутки', () => {
    const now = Date.parse('2026-09-25T12:00:00Z');
    expect(chartRange('2026-09-25T11:30:00Z', now)).toBe('1h');
    expect(chartRange('2026-09-25T10:00:00Z', now)).toBe('24h');
  });
});

describe('pctSeries', () => {
  it('диск и память — доля от общего, точки без данных и нулевой итог пропускаются', () => {
    const r = pctSeries(
      'diskPct',
      series({
        diskUsedMb: [
          { t: 1, v: 50 },
          { t: 2, v: null },
          { t: 3, v: 90 },
          { t: 4, v: 10 },
        ],
        diskTotalMb: [
          { t: 1, v: 100 },
          { t: 2, v: 100 },
          { t: 3, v: 100 },
          { t: 4, v: 0 },
        ],
      }),
    );
    expect(r).toEqual([
      { t: 1, v: 50 },
      { t: 3, v: 90 },
    ]);
  });
  it('CPU берётся как есть', () => {
    expect(
      pctSeries(
        'cpuPct',
        series({
          cpuPct: [
            { t: 1, v: 12 },
            { t: 2, v: null },
          ],
        }),
      ),
    ).toEqual([{ t: 1, v: 12 }]);
  });
  it('нет данных — пустой ряд', () => {
    expect(pctSeries('memPct', series({}))).toEqual([]);
  });
});

describe('buildGeometry', () => {
  const pts = [10, 30, 60, 91].map((v, i) => ({ t: 1000 + i * 600, v }));
  it('меньше двух точек графика нет', () => {
    expect(buildGeometry([{ t: 1, v: 1 }], 85)).toBeNull();
    expect(buildGeometry([], null)).toBeNull();
  });
  it('строит линию и площадь, порог попадает в кадр, шкала охватывает и порог', () => {
    const g = buildGeometry(pts, 85);
    expect(g?.line.startsWith('M0,')).toBe(true);
    expect(g?.area.endsWith('Z')).toBe(true);
    expect(g?.thresholdTop).not.toBeNull();
    expect(g?.yMax).toBeGreaterThanOrEqual(91);
    expect(g?.yMin).toBeLessThanOrEqual(10);
  });
  it('порог вне шкалы не рисуется', () => {
    const g = buildGeometry(
      [
        { t: 0, v: 10 },
        { t: 60, v: 12 },
      ],
      95,
    );
    expect(g?.yMax).toBeGreaterThanOrEqual(95);
    const g2 = buildGeometry(
      [
        { t: 0, v: 10 },
        { t: 60, v: 12 },
      ],
      null,
    );
    expect(g2?.thresholdTop).toBeNull();
  });
  it('очень ровный ряд получает шкалу не уже 10 пунктов', () => {
    const g = buildGeometry(
      [
        { t: 0, v: 50 },
        { t: 60, v: 50 },
      ],
      null,
    );
    expect((g?.yMax ?? 0) - (g?.yMin ?? 0)).toBeGreaterThanOrEqual(10);
  });
  it('xOf: внутри окна — процент, снаружи — null', () => {
    const g = buildGeometry(pts, null);
    expect(g?.xOf(1000)).toBe(0);
    expect(g?.xOf(1000 + 3 * 600)).toBe(100);
    expect(g?.xOf(500)).toBeNull();
  });
});

describe('spreadMarkers', () => {
  it('соседние значки разведены минимум на gap, порядок сохраняется', () => {
    const out = spreadMarkers([{ x: 50 }, { x: 50.5 }, { x: 51 }, { x: 80 }]);
    for (let i = 1; i < out.length; i += 1)
      expect((out[i]?.shown ?? 0) - (out[i - 1]?.shown ?? 0)).toBeGreaterThanOrEqual(4.5 - 1e-9);
    expect(out[3]?.shown).toBe(80);
  });
  it('у правого края значки сдвигаются влево и не выходят за предел', () => {
    const out = spreadMarkers([{ x: 98 }, { x: 99 }, { x: 100 }]);
    expect(Math.max(...out.map((m) => m.shown))).toBeLessThanOrEqual(97);
    expect((out[1]?.shown ?? 0) - (out[0]?.shown ?? 0)).toBeGreaterThanOrEqual(4.5 - 1e-9);
  });
});

describe('chartMarkers', () => {
  it('открытие и попытки в окне, нумерация попыток по порядку; вне окна пропускаются', () => {
    const g = buildGeometry(
      [
        { t: 1000, v: 10 },
        { t: 2000, v: 90 },
      ],
      null,
    );
    if (!g) throw new Error('нет геометрии');
    const iso = (t: number) => new Date(t * 1000).toISOString();
    const m = chartMarkers(
      {
        openedAt: iso(1200),
        attempts: [
          { id: 'a', action: 'free_disk', startedAt: iso(500) },
          { id: 'b', action: 'apt_clean', startedAt: iso(1400) },
        ] as never,
      },
      g.xOf,
      (k) => `шаг ${k}`,
    );
    expect(m.map((x) => x.label)).toEqual(['!', '2']);
    expect(m[1]?.title).toBe('шаг apt_clean');
  });
});
