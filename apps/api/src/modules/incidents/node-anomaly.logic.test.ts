import { describe, expect, it } from 'vitest';

import {
  collapseBaseline,
  minutesText,
  ONLINE_GAP_MAX_MS,
  onlineBaseline,
  samplesFromSeries,
  withSample,
} from './node-anomaly.logic.js';

const MIN = 60_000;
const T0 = Date.parse('2026-09-30T09:00:00.000Z');
/** Снимки раз в минуту, начиная с T0. */
const every = (values: number[], from = T0) => values.map((online, i) => ({ at: from + i * MIN, online }));

describe('onlineBaseline: с чем сравнивать свежий онлайн', () => {
  it('наибольший онлайн за пять минут, а не предыдущая минута', () => {
    // Падение ступеньками: 300 → 200 → 110, свежий снимок — 30. С предыдущей минутой (110) это −73 %,
    // порог 80 % не пройден; с наибольшим за окно (300) — −90 %.
    const prior = every([300, 300, 200, 110]);
    expect(onlineBaseline(prior, T0 + 4 * MIN)?.online).toBe(300);
  });

  it('снимки старше окна базой не становятся', () => {
    // Высокий онлайн был семь минут назад; последние пять минут он 40.
    const prior = every([300, 300, 40, 40, 40, 40, 40]);
    expect(onlineBaseline(prior, T0 + 7 * MIN)?.online).toBe(40);
  });

  it('при равных значениях берётся более поздний снимок', () => {
    const prior = every([300, 300, 300]);
    expect(onlineBaseline(prior, T0 + 3 * MIN)?.at).toBe(T0 + 2 * MIN);
  });

  it('перерыв в снимках (панель перезапускалась): базой остаётся онлайн до перерыва', () => {
    const prior = every([290, 300, 295]);
    // Следующий снимок — через двенадцать минут после последнего.
    expect(onlineBaseline(prior, T0 + 14 * MIN)?.online).toBe(300);
  });

  it('перерыв дольше получаса — сравнивать не с чем: онлайн за это время меняется и сам', () => {
    const prior = every([300, 300, 300]);
    const last = T0 + 2 * MIN;
    expect(onlineBaseline(prior, last + ONLINE_GAP_MAX_MS)?.online).toBe(300);
    expect(onlineBaseline(prior, last + ONLINE_GAP_MAX_MS + 1)).toBeNull();
  });

  it('снимков ещё нет — базы нет', () => {
    expect(onlineBaseline([], T0)).toBeNull();
  });
});

describe('collapseBaseline: длительный обвал онлайна', () => {
  it('высокий уровень подтверждают три снимка, а не один пик', () => {
    const prior = every([600, 610, 590, 300, 120, 30]);
    expect(collapseBaseline(prior, T0 + 6 * MIN)).toMatchObject({ online: 590, at: T0 + 2 * MIN });

    const oneSpike = every([30, 30, 600, 30, 30, 30]);
    expect(collapseBaseline(oneSpike, T0 + 6 * MIN)?.online).toBe(30);
  });

  it('перерыв больше получаса не сравнивает свежий онлайн со старым', () => {
    const prior = every([600, 600, 600]);
    expect(collapseBaseline(prior, T0 + 2 * MIN + ONLINE_GAP_MAX_MS + 1)).toBeNull();
  });
});

describe('withSample', () => {
  it('новый снимок в конец, история за шесть часов сохраняется', () => {
    const next = withSample(every([1, 2, 3, 4, 5, 6, 7]), { at: T0 + 7 * MIN, online: 8 });
    expect(next.map((s) => s.online)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it('снимки старше шести часов удаляются', () => {
    const old = { at: T0, online: 600 };
    const recent = { at: T0 + 359 * MIN, online: 30 };
    const fresh = { at: T0 + 361 * MIN, online: 29 };
    expect(withSample([old, recent], fresh)).toEqual([recent, fresh]);
  });
});

describe('samplesFromSeries: история из сохранённых измерений', () => {
  it('точки по нодам, по возрастанию времени, время — в миллисекундах', () => {
    const map = samplesFromSeries([
      {
        labels: { node_uuid: 'a', node_name: 'Нидерланды - 1' },
        points: [
          [1_790_000_120, 300],
          [1_790_000_060, 290],
        ],
      },
      { labels: { node_uuid: 'b', node_name: 'Германия - 1' }, points: [[1_790_000_060, 12]] },
    ]);
    expect(map.get('a')).toEqual([
      { at: 1_790_000_060_000, online: 290 },
      { at: 1_790_000_120_000, online: 300 },
    ]);
    expect(map.get('b')).toEqual([{ at: 1_790_000_060_000, online: 12 }]);
  });

  it('ноду переименовали — два ряда одной ноды сливаются, мусор пропускается', () => {
    const map = samplesFromSeries([
      { labels: { node_uuid: 'a', node_name: 'Старое имя' }, points: [[60, 100]] },
      {
        labels: { node_uuid: 'a', node_name: 'Новое имя' },
        points: [
          [60, 120],
          [120, Number.NaN],
          [180, 90],
        ],
      },
      { labels: { node_name: 'без идентификатора' }, points: [[60, 5]] },
    ]);
    expect([...map.keys()]).toEqual(['a']);
    expect(map.get('a')).toEqual([
      { at: 60_000, online: 120 },
      { at: 180_000, online: 90 },
    ]);
  });
});

describe('minutesText', () => {
  it('склоняет «минуту / минуты / минут»', () => {
    expect([1, 2, 5, 11, 12, 21, 22, 25].map(minutesText)).toEqual([
      '1 минуту',
      '2 минуты',
      '5 минут',
      '11 минут',
      '12 минут',
      '21 минуту',
      '22 минуты',
      '25 минут',
    ]);
  });
});
