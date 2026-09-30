import { describe, expect, it } from 'vitest';

import {
  INCIDENTS_SETTINGS_DEFAULTS,
  incidentsSettingsSchema,
  incidentsSettingsUpdateSchema,
} from './incidents.js';

describe('настройки инцидентов: схема сохранения раздела', () => {
  it('одно поле остаётся одним полем — режимы по сигналам и пауза не подставляются', () => {
    expect(incidentsSettingsUpdateSchema.parse({ cpuPct: 95 })).toEqual({ cpuPct: 95 });
    expect(incidentsSettingsUpdateSchema.parse({})).toEqual({});
  });

  it('режимы по сигналам и паузу раздел не принимает, даже если их прислали', () => {
    const parsed = incidentsSettingsUpdateSchema.parse({
      cpuPct: '95',
      autofixEnabled: true,
      policy: {},
      pausedUntil: null,
    });
    expect(parsed).toEqual({ cpuPct: 95, autofixEnabled: true });
  });

  it('границы полей те же, что у полной схемы', () => {
    expect(incidentsSettingsUpdateSchema.safeParse({ cpuPct: 40 }).success).toBe(false);
    expect(incidentsSettingsUpdateSchema.safeParse({ autofixCooldownMinutes: 241 }).success).toBe(false);
    expect(incidentsSettingsUpdateSchema.safeParse({ forDurationMinutes: 0 }).success).toBe(false);
  });

  it('полная схема по-прежнему читает старую запись без режимов и паузы', () => {
    const { policy: _p, pausedUntil: _u, ...stored } = INCIDENTS_SETTINGS_DEFAULTS;
    expect(incidentsSettingsSchema.parse(stored)).toEqual(INCIDENTS_SETTINGS_DEFAULTS);
  });
});
