import { describe, expect, it } from 'vitest';

import { maintenanceActive, nodeMaintenanceSchema, nodeMaintenanceStartSchema } from './maintenance.js';

describe('обслуживание ноды', () => {
  it('сроки — только 30 мин, 1 ч, 3 ч или без срока', () => {
    for (const minutes of [30, 60, 180, null])
      expect(nodeMaintenanceStartSchema.safeParse({ minutes }).success, String(minutes)).toBe(true);
    for (const minutes of [0, 15, 61, 1440, '60'])
      expect(nodeMaintenanceStartSchema.safeParse({ minutes }).success, String(minutes)).toBe(false);
  });

  it('причина необязательна, пробелы по краям убираются, длиннее 200 знаков — ошибка по-русски', () => {
    expect(nodeMaintenanceStartSchema.parse({ minutes: 60 })).toEqual({
      minutes: 60,
      reason: '',
      hideHosts: false,
    });
    expect(nodeMaintenanceStartSchema.parse({ minutes: 60, reason: '  Обновляю ядро ' }).reason).toBe(
      'Обновляю ядро',
    );
    expect(
      nodeMaintenanceStartSchema.safeParse({ minutes: 60, reason: 'я'.repeat(201) }).error?.issues[0]
        ?.message,
    ).toBe('Причина — не длиннее 200 знаков');
  });

  it('старая запись без Host и причины читается', () => {
    const m = nodeMaintenanceSchema.parse({
      nodeUuid: 'n1',
      nodeName: 'Германия - 1',
      startedAt: '2026-10-15T08:40:00.000Z',
      until: null,
    });
    expect(m).toMatchObject({ reason: '', hideHosts: false, hosts: null });
  });

  it('идёт до срока; без срока — пока не выключат', () => {
    const now = Date.parse('2026-10-15T09:00:00.000Z');
    expect(maintenanceActive({ until: null }, now)).toBe(true);
    expect(maintenanceActive({ until: '2026-10-15T09:00:01.000Z' }, now)).toBe(true);
    expect(maintenanceActive({ until: '2026-10-15T09:00:00.000Z' }, now)).toBe(false);
    expect(maintenanceActive({ until: '2026-10-15T08:00:00.000Z' }, now)).toBe(false);
  });
});
