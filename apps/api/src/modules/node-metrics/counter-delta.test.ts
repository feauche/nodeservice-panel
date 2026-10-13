import { describe, expect, it } from 'vitest';
import { type CounterReading, counterDelta } from './counter-delta.js';

const r = (rxTotal: number, txTotal: number, uptime: number, used: number | null = null, iface = 'ens3') =>
  ({ rxTotal, txTotal, uptime, iface, used }) satisfies CounterReading;

describe('Разница счётчиков ноды', () => {
  it('первое показание — точка отсчёта, промежутка ещё нет', () => {
    expect(counterDelta(null, r(1000, 2000, 50), 60)).toEqual({ net: null, usedBytes: null, advance: true });
  });
  it('обычная минута: байты — разница, время — по часам ноды, а не панели', () => {
    // Панель насчитала 61 с, а между показаниями Remnawave — 60 с по часам ноды.
    expect(counterDelta(r(1_000, 2_000, 100, 500), r(61_000, 92_000, 160, 800), 61)).toEqual({
      net: { rxBytes: 60_000, txBytes: 90_000, dt: 60 },
      usedBytes: 300,
      advance: true,
    });
  });
  it('Remnawave ещё не обновила показание — промежутка нет, прежняя точка отсчёта остаётся', () => {
    expect(counterDelta(r(1000, 2000, 100), r(1000, 2000, 100), 15)).toEqual({
      net: null,
      usedBytes: null,
      advance: false,
    });
  });
  it('сервер перезагрузился внутри промежутка — считаем то, что набежало после загрузки', () => {
    expect(counterDelta(r(9_000_000, 9_000_000, 864_000), r(4_000, 6_000, 40, null), 60).net).toEqual({
      rxBytes: 4_000,
      txBytes: 6_000,
      dt: 40,
    });
  });
  it('счётчик уменьшился, а сервер не перезагружался — промежуток неизвестен', () => {
    expect(counterDelta(r(9_000, 9_000, 100), r(4_000, 9_500, 5_000), 60).net).toBeNull();
  });
  it('сменилась сетевая карта — отсчёт заново; трафик пользователей считается', () => {
    expect(counterDelta(r(10, 10, 100, 100), r(20, 20, 160, 150, 'eth0'), 60)).toEqual({
      net: null,
      usedBytes: 50,
      advance: true,
    });
  });
  it('счётчик трафика пользователей обнулили — считаем с нуля', () => {
    expect(counterDelta(r(10, 10, 100, 9_000), r(70, 70, 160, 120), 60).usedBytes).toBe(120);
  });
  it('невозможная скорость (сбой счётчика) — промежуток не считаем', () => {
    expect(counterDelta(r(0, 0, 100), r(2e15, 10, 160), 60).net).toBeNull();
  });
});
