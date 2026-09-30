import { describe, expect, it } from 'vitest';

import { moscowDate, rateDayPhrase, ratesUpdatedLabel } from './billing-format';

describe('ratesUpdatedLabel', () => {
  // Местное время браузера: 30 сентября 2026, 18:05.
  const now = new Date(2026, 8, 30, 18, 5).getTime();
  const at = (day: number, h: number, m: number) => new Date(2026, 8, day, h, m).toISOString();

  it('дата курса для подписей «по курсу ЦБ …»: сегодняшняя — «сегодня», старая — числом', () => {
    expect(rateDayPhrase(moscowDate(now), now)).toBe('сегодня');
    expect(rateDayPhrase('2026-09-27', now)).toBe('на 27 сентября');
    expect(rateDayPhrase(null, now)).toBe('сегодня');
  });

  it('курс получен сегодня — только время', () => {
    expect(ratesUpdatedLabel(at(30, 14, 0), now)).toBe('Обновлено 14:00');
    expect(ratesUpdatedLabel(at(30, 0, 3), now)).toBe('Обновлено 00:03');
  });

  it('вчера по календарю браузера — так и написано', () => {
    expect(ratesUpdatedLabel(at(29, 9, 7), now)).toBe('Обновлено вчера, 09:07');
  });

  it('раньше — дата без времени', () => {
    expect(ratesUpdatedLabel(at(27, 9, 7), now)).toBe('Обновлено 27 сентября');
  });
});
