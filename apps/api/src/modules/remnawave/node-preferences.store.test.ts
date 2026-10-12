import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it, vi } from 'vitest';
import { NodePreferencesStore } from './node-preferences.store.js';

describe('Пороги мониторинга из одного снимка', () => {
  it('не запрашивает второй снимок и сохраняет доменную изоляцию', async () => {
    const findFirst = vi.fn(async () => ({ value: '{"cpuWarningPercent":75,"memoryWarningPercent":80}' }));
    const snapshot = vi.fn();
    const store = new NodePreferencesStore(
      { query: { appMeta: { findFirst } } } as never,
      { snapshot } as never,
    );
    expect(await store.forMonitoring('panel.example', 'node')).toMatchObject({
      cpuWarningPercent: 75,
      memoryWarningPercent: 80,
    });
    expect(snapshot).not.toHaveBeenCalled();
    expect(new PgDialect().sqlToQuery(findFirst.mock.calls[0][0].where).params).toContain(
      'settings.node-view.panel.example:node',
    );
  });
  it.each([null, { value: '{}' }, { value: 'broken' }, { value: '{"cpuWarningPercent":900}' }])(
    'отсутствующие или повреждённые настройки наследуют общие: %j',
    async (row) => {
      const store = new NodePreferencesStore(
        { query: { appMeta: { findFirst: async () => row } } } as never,
        {} as never,
      );
      expect(await store.forMonitoring('panel', 'node')).toMatchObject({
        cpuWarningPercent: null,
        memoryWarningPercent: null,
      });
    },
  );
});
