import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it, vi } from 'vitest';
import { NodeEventsStore } from './node-events.store.js';

describe('Общая история проверок', () => {
  it('область панели и ноды фильтруется до лимита; факты без ключей', async () => {
    const execute = vi.fn(async () => ({ rows: [] }));
    const store = new NodeEventsStore({ execute } as never);
    await store.append('panel.test', {
      id: 'dpi:1:done',
      t: 100,
      nodeUuid: 'node',
      nodeName: 'Нода',
      type: 'dpi_check',
      title: 'DPI завершена',
      summary: '1/2 доступно',
      link: '/integrations/dpi',
    });
    await store.list('another.panel', ['node'], 0, 200);
    const dialect = new PgDialect(),
      insert = dialect.sqlToQuery(execute.mock.calls[0][0]),
      select = dialect.sqlToQuery(execute.mock.calls[1][0]);
    expect(insert.sql).toContain('ON CONFLICT');
    expect(insert.params[0]).not.toBe(select.params[0]);
    expect(select.sql).toContain('LIMIT 1001');
    expect(select.params).toContain('node');
  });
});
