import type { NodeMaintenance } from '@nodeservice/shared';
import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it, vi } from 'vitest';
import { NodeMaintenanceStore } from './node-maintenance.store.js';

const m = (uuid: string, until: string | null): NodeMaintenance => ({
  nodeUuid: uuid,
  nodeName: uuid,
  startedAt: '2026-10-15T08:40:00.000Z',
  until,
  reason: '',
  hideHosts: false,
  hosts: null,
});

/** Память вместо app_meta: одна строка на ключ. */
function fakeDb(initial?: string) {
  let value = initial ?? null;
  const findFirst = vi.fn(async () => (value === null ? undefined : { value }));
  const db = {
    query: { appMeta: { findFirst } },
    insert: () => ({
      values: (v: { value: string }) => ({
        onConflictDoUpdate: async () => {
          value = v.value;
        },
      }),
    }),
  };
  return { db, findFirst, read: () => value };
}

describe('Записи обслуживания нод', () => {
  it('ключ — на подключение Remnawave; без подключения обслуживания нет', async () => {
    const { db, findFirst } = fakeDb('{}');
    const store = new NodeMaintenanceStore(db as never);
    expect((await store.all(null)).size).toBe(0);
    expect(findFirst).not.toHaveBeenCalled();
    await store.all('panel.example');
    expect(new PgDialect().sqlToQuery(findFirst.mock.calls[0]?.[0].where).params).toContain(
      'nodes.maintenance.panel.example',
    );
  });

  it('идущие — без срока и со сроком в будущем; истёкшие видны только в полном списке', async () => {
    const now = Date.parse('2026-10-15T09:00:00.000Z');
    const { db } = fakeDb(
      JSON.stringify({
        a: m('a', null),
        b: m('b', '2026-10-15T09:30:00.000Z'),
        c: m('c', '2026-10-15T08:59:00.000Z'),
      }),
    );
    const store = new NodeMaintenanceStore(db as never);
    expect([...(await store.active('p', now)).keys()]).toEqual(['a', 'b']);
    expect([...(await store.all('p')).keys()]).toEqual(['a', 'b', 'c']);
  });

  it('повреждённая запись одной ноды не прячет остальные; испорченный JSON — обслуживания нет', async () => {
    const store = new NodeMaintenanceStore(
      fakeDb(JSON.stringify({ a: m('a', null), bad: { nodeUuid: 5 } })).db as never,
    );
    expect([...(await store.all('p')).keys()]).toEqual(['a']);
    expect((await new NodeMaintenanceStore(fakeDb('{oops').db as never).all('p')).size).toBe(0);
  });

  it('добавить и убрать: остальные ноды не теряются', async () => {
    const fake = fakeDb(JSON.stringify({ a: m('a', null) }));
    const store = new NodeMaintenanceStore(fake.db as never);
    await store.put('p', m('b', null));
    expect(Object.keys(JSON.parse(fake.read() ?? '{}'))).toEqual(['a', 'b']);
    expect((await store.remove('p', 'a'))?.nodeUuid).toBe('a');
    expect(Object.keys(JSON.parse(fake.read() ?? '{}'))).toEqual(['b']);
    expect(await store.remove('p', 'zzz')).toBeNull();
  });
});
