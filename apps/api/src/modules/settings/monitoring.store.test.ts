import { MONITORING_DEFAULTS } from '@nodeservice/shared';
import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it, vi } from 'vitest';
import { MonitoringStore } from './monitoring.store.js';

function setup(current?: string, legacy?: string, concurrent?: string) {
  const rows = new Map<string, string>();
  if (current !== undefined) rows.set('settings.monitoring', current);
  if (legacy !== undefined) rows.set('settings.autochecks', legacy);
  const insert = vi.fn(() => ({
    values: (value: { key: string; value: string }) => ({
      onConflictDoNothing: async () => {
        if (concurrent !== undefined) rows.set(value.key, concurrent);
        if (!rows.has(value.key)) rows.set(value.key, value.value);
      },
      onConflictDoUpdate: async () => {
        rows.set(value.key, value.value);
      },
    }),
  }));
  const findFirst = vi.fn(async (args: { where: never }) => {
    const key = new PgDialect().sqlToQuery(args.where).params[0] as string;
    const value = rows.get(key);
    return value === undefined ? undefined : { value };
  });
  return { store: new MonitoringStore({ query: { appMeta: { findFirst } }, insert } as never), rows, insert };
}

describe('MonitoringStore upgrade compatibility', () => {
  it.each([{ metricsEnabled: false }, { enabled: false }, { metricsEnabled: false, sshEnabled: true }])(
    'preserves legacy disabled checks %j and persists the mapped settings once',
    async (legacy) => {
      const { store, rows, insert } = setup(undefined, JSON.stringify(legacy));
      expect((await store.get()).enabled).toBe(false);
      expect((await store.get()).enabled).toBe(false);
      expect(insert).toHaveBeenCalledOnce();
      // В записи — только отличие от значений по умолчанию и версия.
      expect(JSON.parse(rows.get('settings.monitoring') ?? '{}')).toEqual({ enabled: false, _v: 4 });
      expect(rows.get('settings.autochecks')).toBe(JSON.stringify(legacy));
    },
  );
  it('keeps explicit current settings, even when the old settings were disabled', async () => {
    const explicit = { ...MONITORING_DEFAULTS, enabled: true, pollSeconds: 180 };
    const { store, rows, insert } = setup(
      JSON.stringify(explicit),
      JSON.stringify({ metricsEnabled: false }),
    );
    expect(await store.get()).toEqual(explicit);
    // Один раз запись сжимается до отличий; дальше не переписывается.
    expect(JSON.parse(rows.get('settings.monitoring') ?? '{}')).toEqual({ pollSeconds: 180, _v: 4 });
    await store.get();
    expect(insert).toHaveBeenCalledOnce();
  });
  it('does not overwrite an explicit save racing the first legacy migration', async () => {
    const explicit = { ...MONITORING_DEFAULTS, enabled: true, pollSeconds: 120 };
    const { store } = setup(undefined, JSON.stringify({ metricsEnabled: false }), JSON.stringify(explicit));
    expect(await store.get()).toEqual(explicit);
  });
  it.each(['broken json', 'null', '[]', '{"metricsEnabled":"false"}', '{"metricsIntervalSeconds":1}'])(
    'disables new monitoring for damaged legacy settings %s',
    async (legacy) => {
      expect((await setup(undefined, legacy).store.get()).enabled).toBe(false);
    },
  );
  it('uses optimal defaults for a fresh installation and valid enabled legacy metrics', async () => {
    expect(await setup().store.get()).toEqual(MONITORING_DEFAULTS);
    expect(await setup(undefined, '{"metricsEnabled":true}').store.get()).toEqual(MONITORING_DEFAULTS);
  });
  it('0.94.0: прежние значения по умолчанию переходят на быстрые один раз, изменённые вручную — нет', async () => {
    const before = {
      ...MONITORING_DEFAULTS,
      pollSeconds: 60,
      apiTimeoutSeconds: 15,
      staleAfterMinutes: 5,
      confirmSamples: 3,
      recoverySamples: 3,
      checkHostCooldownMinutes: 30,
      cpuPercent: 90,
    };
    const { store, rows } = setup(JSON.stringify(before));
    const got = await store.get();
    expect(got).toMatchObject({
      pollSeconds: 15,
      apiTimeoutSeconds: 10,
      staleAfterMinutes: 2,
      confirmSamples: 4,
    });
    // Своё значение (30 мин вместо прежних 15) осталось; процента процессора больше нет, порог — нагрузка на ядро.
    expect(got.checkHostCooldownMinutes).toBe(30);
    expect(got.loadPerCore).toBe(1.5);
    expect(JSON.parse(rows.get('settings.monitoring') ?? '{}')).not.toHaveProperty('cpuPercent');
    // Сохранённое после переноса — с версией: позднее «60 секунд» вручную больше не переносится.
    await store.set({ pollSeconds: 60 });
    expect((await store.get()).pollSeconds).toBe(60);
  });
  it('0.95.0: 5 минут превышения из 0.94.0 переходят на 2, ручные значения 0.94.0 остаются, новые значения по умолчанию доходят', async () => {
    const saved094 = { ...MONITORING_DEFAULTS, resourceDurationMinutes: 5, pollSeconds: 60, _v: 2 };
    const { store, rows } = setup(JSON.stringify(saved094));
    const got = await store.get();
    expect(got.resourceDurationMinutes).toBe(2);
    // «60 секунд» сохранено уже в 0.94.0 — выбрано вручную, не переносится.
    expect(got.pollSeconds).toBe(60);
    expect(JSON.parse(rows.get('settings.monitoring') ?? '{}')).toEqual({ pollSeconds: 60, _v: 4 });
    // Сохранение пишет только отличия: значения по умолчанию в запись не попадают.
    await store.set({ memoryPercent: 85, confirmSamples: MONITORING_DEFAULTS.confirmSamples });
    expect(JSON.parse(rows.get('settings.monitoring') ?? '{}')).toEqual({
      pollSeconds: 60,
      memoryPercent: 85,
      _v: 4,
    });
    const own = setup(JSON.stringify({ ...MONITORING_DEFAULTS, resourceDurationMinutes: 10, _v: 2 }));
    expect((await own.store.get()).resourceDurationMinutes).toBe(10);
  });
  it('0.97.0: возврат онлайна 70 % из прежних версий переходит на 50 %, выбранное вручную остаётся', async () => {
    const saved094 = setup(JSON.stringify({ ...MONITORING_DEFAULTS, recoveryPercent: 70, _v: 2 }));
    expect((await saved094.store.get()).recoveryPercent).toBe(50);
    expect(JSON.parse(saved094.rows.get('settings.monitoring') ?? '{}')).toEqual({ _v: 4 });
    expect((await setup(JSON.stringify({ recoveryPercent: 70, _v: 3 })).store.get()).recoveryPercent).toBe(
      50,
    );
    expect((await setup(JSON.stringify({ recoveryPercent: 60, _v: 3 })).store.get()).recoveryPercent).toBe(
      60,
    );
    // Сохранено уже после 0.97.0 — выбрано вручную, остаётся 70.
    expect((await setup(JSON.stringify({ recoveryPercent: 70, _v: 4 })).store.get()).recoveryPercent).toBe(
      70,
    );
  });
  it('does not enable monitoring when the current record is damaged', async () => {
    expect((await setup('bad json').store.get()).enabled).toBe(false);
    expect((await setup('null').store.get()).enabled).toBe(false);
    expect((await setup('[]').store.get()).enabled).toBe(false);
    expect((await setup('{"enabled":false,"pollSeconds":0}').store.get()).enabled).toBe(false);
  });
});
