import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  configureIdleLimit,
  idleMs,
  installActivityTracking,
  lastActivityAt,
  markActivity,
  resetActivity,
} from './activity';

const MIN = 60_000;

describe('время последнего действия человека', () => {
  beforeEach(() => {
    localStorage.clear();
    configureIdleLimit(0, null);
    resetActivity();
  });
  afterEach(() => configureIdleLimit(0, null));

  it('бездействие растёт, действие начинает отсчёт заново', () => {
    const now = Date.now();
    resetActivity(now - 3 * MIN);
    expect(idleMs(now)).toBe(3 * MIN);
    markActivity(now);
    expect(idleMs(now)).toBe(0);
  });

  it('одно время на все вкладки: действие в другой вкладке тоже считается', () => {
    const now = Date.now();
    resetActivity(now - 20 * MIN);
    // другая вкладка той же панели записала своё действие минуту назад
    localStorage.setItem('ns-last-activity', String(now - MIN));
    expect(lastActivityAt()).toBe(now - MIN);
    expect(idleMs(now)).toBe(MIN);
  });

  it('вернулся после перерыва дольше срока — сначала блокировка, а не новый отсчёт', () => {
    const now = Date.now();
    resetActivity(now - 31 * MIN);
    const exceed = vi.fn();
    configureIdleLimit(30 * MIN, exceed);
    markActivity(now);
    expect(exceed).toHaveBeenCalledTimes(1);
    expect(idleMs(now)).toBe(31 * MIN); // отсчёт не сброшен
    markActivity(now); // срок уже снят — повторной блокировки нет
    expect(exceed).toHaveBeenCalledTimes(1);
  });

  it('движение мыши без сдвига курсора (браузер шлёт его сам при обновлении страницы) — не действие', () => {
    installActivityTracking();
    const now = Date.now();
    window.dispatchEvent(new MouseEvent('mousemove', { screenX: 10, screenY: 10 }));
    resetActivity(now - 5 * MIN);
    window.dispatchEvent(new MouseEvent('mousemove', { screenX: 10, screenY: 10 }));
    expect(idleMs()).toBeGreaterThanOrEqual(5 * MIN);
    window.dispatchEvent(new MouseEvent('mousemove', { screenX: 12, screenY: 10 }));
    expect(idleMs()).toBeLessThan(1_000);
  });

  it('прокрутка сама по себе — не действие (живые списки прокручиваются без человека)', () => {
    installActivityTracking();
    resetActivity(Date.now() - 5 * MIN);
    window.dispatchEvent(new Event('scroll'));
    expect(idleMs()).toBeGreaterThanOrEqual(5 * MIN);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown' }));
    expect(idleMs()).toBeLessThan(1_000);
  });
});
