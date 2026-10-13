import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import { ScenariosStore } from './scenarios.store.js';

const rule = {
  id: '22222222-2222-4222-8222-222222222222',
  name: 'Критическое падение онлайна',
  enabled: true,
  scope: 'all',
  nodes: [],
  hostBindings: [],
  trigger: 'offline',
  conditions: [],
  conditionMode: 'all',
  holdMinutes: 5,
  actions: ['rename_host', 'notify'],
  renameMode: 'append',
  renameText: '⚠️',
  autoRestore: false,
  cooldownMinutes: 30,
};
function setup(stored: unknown) {
  const rows = new Map<string, string>();
  const store = new ScenariosStore({
    query: {
      appMeta: {
        findFirst: async (args: { where: never }) => {
          const value = rows.get(new PgDialect().sqlToQuery(args.where).params[0] as string);
          return value === undefined ? undefined : { value };
        },
      },
    },
    insert: () => ({
      values: (v: { key: string; value: string }) => ({
        onConflictDoUpdate: async () => {
          rows.set(v.key, v.value);
        },
      }),
    }),
  } as never);
  rows.set(`scenarios.rules.${store.scope('panel.test')}`, JSON.stringify(stored));
  const saved = () => JSON.parse(rows.get(`scenarios.rules.${store.scope('panel.test')}`) ?? '{}');
  return { store, saved };
}

describe('Сценарии: перевод на 0.95.0', () => {
  it('прежние 5 минут «держится» становятся 1 минутой один раз; остальное и «Возвращать Host» не трогаем', async () => {
    const { store, saved } = setup({
      items: [rule, { ...rule, id: '33333333-3333-4333-8333-333333333333', holdMinutes: 3 }],
    });
    const items = await store.list('panel.test');
    expect(items.map((r) => r.holdMinutes)).toEqual([1, 3]);
    // Выбор владельца у уже созданного сценария остаётся: включённым по умолчанию возврат стал только у новых.
    expect(items[0]?.autoRestore).toBe(false);
    expect(saved()).toMatchObject({ _v: 2 });
    // Сохранённое после перевода — с версией: позднее выбранные 5 минут остаются.
    await store.set('panel.test', [{ ...items[0], holdMinutes: 5 } as never]);
    expect((await store.list('panel.test'))[0]?.holdMinutes).toBe(5);
  });
  it('новый сценарий без явных значений: 1 минута и возврат Host включён', async () => {
    const { holdMinutes, autoRestore, ...bare } = rule;
    const { store } = setup({ items: [bare], _v: 2 });
    expect((await store.list('panel.test'))[0]).toMatchObject({ holdMinutes: 1, autoRestore: true });
    expect([holdMinutes, autoRestore]).toEqual([5, false]);
  });
});
