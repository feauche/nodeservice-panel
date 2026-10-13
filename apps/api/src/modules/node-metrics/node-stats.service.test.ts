import { PgDialect } from 'drizzle-orm/pg-core';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { downtimeWithin, hourWindow, localDayStart, NodeStatsService } from './node-stats.service.js';

describe('отчёт за период', () => {
  it('часы пика и тишины — четыре часа подряд, в том числе через полночь', () => {
    // Пик вечером 21–01, тише всего утром 06–10.
    const hourly = Array.from({ length: 24 }, (_, h) =>
      h >= 21 || h < 1 ? 900 : h >= 6 && h < 10 ? 100 : 500,
    );
    expect(hourWindow(hourly, 'max')).toEqual({ from: 21, to: 1 });
    expect(hourWindow(hourly, 'min')).toEqual({ from: 6, to: 10 });
    expect(hourWindow(Array(24).fill(null), 'max')).toBeNull();
  });

  it('простой считается только внутри периода; открытое событие — до конца периода', () => {
    const from = 1_000;
    const to = 10_000;
    expect(
      downtimeWithin(
        [
          { node: 'a', openedAt: 0, resolvedAt: 2_000 }, // началось до периода: 1 000
          { node: 'b', openedAt: 3_000, resolvedAt: 4_000 }, // целиком внутри: 1 000
          { node: 'c', openedAt: 9_000, resolvedAt: null }, // ещё открыто: 1 000
          { node: 'd', openedAt: 11_000, resolvedAt: 12_000 }, // после периода: 0
        ],
        from,
        to,
      ),
    ).toBe(3_000);
  });

  it('события одной ноды, наложенные друг на друга, не считаются дважды', () => {
    expect(
      downtimeWithin(
        [
          { node: 'a', openedAt: 1_000, resolvedAt: 4_000 },
          { node: 'a', openedAt: 2_000, resolvedAt: 3_000 },
          { node: 'a', openedAt: 3_500, resolvedAt: 5_000 },
          { node: 'b', openedAt: 2_000, resolvedAt: 3_000 },
          { node: null, openedAt: 2_000, resolvedAt: 3_000 },
          { node: null, openedAt: 2_000, resolvedAt: 3_000 },
        ],
        0,
        10_000,
      ),
    ).toBe(4_000 + 1_000 + 2_000);
  });
});

describe('Трафик в «Статистике»: трафик пользователей, как в Remnawave, по суткам пояса панели', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });
  it('сутки начинаются в полночь пояса панели', () => {
    expect(new Date(localDayStart('2026-10-13', 'Asia/Omsk')).toISOString()).toBe('2026-10-12T18:00:00.000Z');
    expect(new Date(localDayStart('2026-10-13', 'Europe/Moscow')).toISOString()).toBe(
      '2026-10-12T21:00:00.000Z',
    );
  });
  /**
   * Отчёт на момент `now` (по умолчанию 13.10 16:00 по Омску) с замерами `measured` (сутки пояса, нода, байт, сутки
   * по Гринвичу — если другие) и началом замеров `since`; Remnawave отдаёт `remote`.
   */
  async function stats(
    days: number,
    since: string | null,
    measured: Array<[string, string, number, string?]>,
    remote?: { categories: string[]; series: Array<{ uuid: string; data: number[] }> },
    now = '2026-10-13T10:00:00Z',
  ) {
    vi.useFakeTimers({ now: Date.parse(now), toFake: ['Date'] });
    const fetch = vi.fn(async () =>
      Response.json({
        response: {
          categories: remote?.categories ?? [],
          sparklineData:
            remote?.categories.map((_, i) => remote.series.reduce((s, x) => s + (x.data[i] ?? 0), 0)) ?? [],
          series:
            remote?.series.map((x) => ({ ...x, name: x.uuid, total: x.data.reduce((a, b) => a + b, 0) })) ??
            [],
        },
      }),
    );
    vi.stubGlobal('fetch', fetch);
    const execute = vi.fn(async (q: unknown) => {
      const text = new PgDialect().sqlToQuery(q as never).sql;
      if (text.includes('AS bytes'))
        return {
          rows: measured.map(([day, uuid, bytes, utcDay]) => ({ day, utc_day: utcDay ?? day, uuid, bytes })),
        };
      if (text.includes('AS since')) return { rows: [{ since }] };
      return { rows: [] };
    });
    const service = new NodeStatsService(
      {
        execute,
        query: { appMeta: { findFirst: async () => ({ value: JSON.stringify({ timeZone: 'Asia/Omsk' }) }) } },
      } as never,
      {
        domain: async () => 'panel',
        credentials: async () => ({ domain: 'panel', apiKey: 'k' }),
      } as never,
      {
        status: async () => ({
          domain: 'panel',
          nodes: [
            { uuid: 'A', name: 'A', countryCode: null, isDisabled: false },
            { uuid: 'B', name: 'B', countryCode: null, isDisabled: false },
          ],
        }),
      } as never,
    );
    return { result: await service.get(days), fetch };
  }
  /** Сколько часов покрывают столбики. */
  const hours = (days: Array<{ from: string; to: string }>) =>
    days.reduce((h, d) => h + (Date.parse(d.to) - Date.parse(d.from)) / 3_600_000, 0);

  it('ровно за период, как онлайн: «Сутки» — последние 24 часа двумя неполными столбиками; Remnawave не нужна', async () => {
    const { result, fetch } = await stats(1, '2026-10-01T00:00:00Z', [
      ['2026-10-12', 'A', 100],
      ['2026-10-12', 'X', 50],
      ['2026-10-13', 'A', 200],
      ['2026-10-13', 'B', 150],
    ]);
    expect(fetch).not.toHaveBeenCalled();
    // 12.10 с 16:00 до полуночи по Омску и 13.10 с полуночи до 16:00.
    expect(result.traffic.days).toEqual([
      {
        date: '2026-10-12',
        total: 150,
        source: 'panel',
        from: '2026-10-12T10:00:00.000Z',
        to: '2026-10-12T18:00:00.000Z',
      },
      {
        date: '2026-10-13',
        total: 350,
        source: 'panel',
        from: '2026-10-12T18:00:00.000Z',
        to: '2026-10-13T10:00:00.000Z',
      },
    ]);
    expect(hours(result.traffic.days)).toBe(24);
  });
  it('итог = сумма по суткам = сумма по нодам с удалёнными; доли — 100 %', async () => {
    const { result } = await stats(1, '2026-10-01T00:00:00Z', [
      ['2026-10-12', 'A', 100],
      ['2026-10-12', 'X', 50],
      ['2026-10-13', 'A', 200],
      ['2026-10-13', 'B', 150],
    ]);
    expect(result.traffic).toMatchObject({ total: 500, removed: 50, error: null });
    expect(result.nodes.map((n) => [n.uuid, n.traffic, n.share])).toEqual([
      ['A', 300, 60],
      ['B', 150, 30],
    ]);
    // 60 % + 30 % + удалённые 10 % = 100 %.
  });
  it('до начала замеров — целые сутки Remnawave, с полуночи по Гринвичу — замеры панели: без двойного счёта и дыры', async () => {
    const dates = [
      '2026-10-06',
      '2026-10-07',
      '2026-10-08',
      '2026-10-09',
      '2026-10-10',
      '2026-10-11',
      '2026-10-12',
    ];
    const { result, fetch } = await stats(
      7,
      // Панель начала считать 11 октября днём; итоги Remnawave — по 11-е по Гринвичу включительно (до 12.10 06:00 по
      // Омску), замеры панели — с этой минуты.
      '2026-10-11T12:00:00Z',
      [
        ['2026-10-12', 'A', 300, '2026-10-11'], // 12.10 00:00–06:00 по Омску: уже в итоге Remnawave за 11-е
        ['2026-10-12', 'A', 1_000],
        ['2026-10-13', 'A', 200, '2026-10-12'],
        ['2026-10-13', 'A', 300],
      ],
      // 06.10 начались до периода (он с 06.10 16:00 по Омску): целым итогом их не заменить.
      { categories: dates, series: [{ uuid: 'A', data: [777, 10, 20, 30, 40, 50, 999] }] },
    );
    expect(String(fetch.mock.calls[0]?.at(0))).toContain('start=2026-10-07&end=2026-10-11');
    expect(result.traffic.days.map((d) => [d.date, d.total, d.source, d.from.slice(0, 16)])).toEqual([
      ['2026-10-07', 10, 'remnawave', '2026-10-07T00:00'],
      ['2026-10-08', 20, 'remnawave', '2026-10-08T00:00'],
      ['2026-10-09', 30, 'remnawave', '2026-10-09T00:00'],
      ['2026-10-10', 40, 'remnawave', '2026-10-10T00:00'],
      ['2026-10-11', 50, 'remnawave', '2026-10-11T00:00'],
      ['2026-10-12', 1_000, 'panel', '2026-10-12T00:00'],
      ['2026-10-13', 500, 'panel', '2026-10-12T18:00'],
    ]);
    expect(result.traffic.total).toBe(1_650);
    expect(result.nodes[0]).toMatchObject({ uuid: 'A', traffic: 1_650, share: 100 });
    // Период — 7 суток с 06.10 16:00 по Омску; без части 06.10 до полуночи по Гринвичу (14 часов) — 6 суток 10 часов.
    expect(hours(result.traffic.days)).toBe(154);
  });
  it('замеров ещё нет, ночь по Омску: сутки Remnawave по Гринвичу, начавшиеся в периоде; будущие не берутся', async () => {
    const { result } = await stats(
      1,
      null,
      [],
      { categories: ['2026-10-12', '2026-10-13'], series: [{ uuid: 'A', data: [900, 400] }] },
      // 14.10 02:00 по Омску — по Гринвичу ещё 13.10 20:00.
      '2026-10-13T20:00:00Z',
    );
    expect(result.traffic.days).toEqual([
      {
        date: '2026-10-13',
        total: 400,
        source: 'remnawave',
        from: '2026-10-13T00:00:00.000Z',
        to: '2026-10-13T20:00:00.000Z',
      },
    ]);
    expect(result.traffic.total).toBe(400);
  });
});
