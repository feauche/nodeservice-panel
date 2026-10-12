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
      expect(JSON.parse(rows.get('settings.monitoring') ?? '{}')).toEqual({
        ...MONITORING_DEFAULTS,
        enabled: false,
      });
      expect(rows.get('settings.autochecks')).toBe(JSON.stringify(legacy));
    },
  );
  it('keeps explicit current settings, even when the old settings were disabled', async () => {
    const explicit = { ...MONITORING_DEFAULTS, enabled: true, pollSeconds: 180 };
    const { store, insert } = setup(JSON.stringify(explicit), JSON.stringify({ metricsEnabled: false }));
    expect(await store.get()).toEqual(explicit);
    expect(insert).not.toHaveBeenCalled();
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
  it('does not enable monitoring when the current record is damaged', async () => {
    expect((await setup('bad json').store.get()).enabled).toBe(false);
    expect((await setup('null').store.get()).enabled).toBe(false);
    expect((await setup('[]').store.get()).enabled).toBe(false);
    expect((await setup('{"enabled":false,"pollSeconds":0}').store.get()).enabled).toBe(false);
  });
});
