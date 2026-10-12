import { describe, expect, it } from 'vitest';

import { type CapacityPoint, estimateCapacity } from './node-capacity.logic.js';

const HOUR = 3_600_000;
/** Неделя замеров: онлайн гуляет от 100 до 500, нагрузка и память растут с ним по прямой. */
function week(over: (online: number) => Partial<CapacityPoint> = () => ({})): CapacityPoint[] {
  return Array.from({ length: 7 * 24 }, (_, i) => {
    const online = 300 + 200 * Math.sin((i / 24) * Math.PI * 2);
    return {
      t: Date.parse('2026-10-01T00:00:00Z') + i * HOUR,
      online,
      // 4 ядра: 0,4 без людей + 0,004 на пользователя → в пик (500) 2,4 = 60 % на ядро.
      load: 0.4 + 0.004 * online,
      // Память: 20 % базово + 0,04 % на пользователя → в пик 40 %.
      ram: 20 + 0.04 * online,
      // Канал: 0,1 МБ/с на пользователя в каждую сторону.
      rx: online * 100_000,
      tx: online * 90_000,
      ...over(online),
    };
  });
}

describe('ёмкость ноды', () => {
  it('процессор — нагрузка на ядро; без лимита канала расчёт предварительный', () => {
    const r = estimateCapacity(week(), { cores: 4, channelMbps: null, disabled: false });
    expect(r.skipped).toBeNull();
    expect(r.peakOnline).toBe(500);
    expect(r.cpu).toBeCloseTo(60, 0);
    expect(r.ram).toBeCloseTo(40, 0);
    expect(r.channel).toBeNull();
    // Процессор: (80 − 10) / 0,1 = 700 пользователей; память: (85 − 20) / 0,04 = 1625. Первым кончится процессор.
    expect(r.bottleneck).toBe('cpu');
    expect(r.extra).toBe(200);
    expect(r.preliminary).toBe(true);
    expect(r.days).toBe(7);
  });

  it('с лимитом канала расчёт точный, и узким местом может стать канал', () => {
    // 100 Мбит/с: 0,8 Мбит/с на пользователя → 90 % канала при 112 пользователях — уже меньше пика.
    const r = estimateCapacity(week(), { cores: 4, channelMbps: 100, disabled: false });
    expect(r.bottleneck).toBe('channel');
    expect(r.extra).toBe(0);
    expect(r.channel).toBeGreaterThan(90);
    expect(r.preliminary).toBe(false);
  });

  it('нагрузка не растёт с онлайном — считаем пропорционально, это осторожнее', () => {
    const r = estimateCapacity(
      week(() => ({ load: 1, ram: 30 })),
      { cores: 4, channelMbps: null, disabled: false },
    );
    // 25 % на ядро при 500 → 80 % при 1600; память 30 % при 500 → 85 % примерно при 1400. Первой кончится память.
    expect(r.bottleneck).toBe('ram');
    expect(r.extra).toBeGreaterThanOrEqual(880);
    expect(r.extra).toBeLessThanOrEqual(910);
  });

  it('выключенная, без нагрузки и с короткой историей — не считаем и говорим почему', () => {
    expect(estimateCapacity(week(), { cores: 4, channelMbps: null, disabled: true }).skipped).toBe(
      'disabled',
    );
    expect(
      estimateCapacity(
        week(() => ({ online: 5 })),
        { cores: 4, channelMbps: null, disabled: false },
      ),
    ).toMatchObject({ skipped: 'idle', peakOnline: 5 });
    expect(
      estimateCapacity(week().slice(0, 6), { cores: 4, channelMbps: null, disabled: false }).skipped,
    ).toBe('collecting');
  });
});
