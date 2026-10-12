import { describe, expect, it, vi } from 'vitest';
import { NodeTcpHistoryService } from './node-tcp-history.service.js';

const uuid = '4fab6a97-4d4e-42b7-a84d-6825b8375a72';
const report = {
  verdict: 'unknown' as const,
  checkedAt: '2026-10-12T00:00:00Z',
  target: '8.8.8.8:5492',
  link: null,
  observations: [],
  error: 'Недостаточно точек',
};
describe('TCP история ноды', () => {
  it('сохраняет неизвестный результат и записывает точную ноду в Журнал; история переживает новый экземпляр сервиса', async () => {
    const rows: { key: string; value: string }[] = [];
    const db = {
      insert: () => ({
        values: async (v: { key: string; value: string }) => {
          rows.push(v);
        },
      }),
      query: { appMeta: { findMany: async () => [...rows, { key: 'broken', value: 'invalid' }] } },
    };
    const record = vi.fn();
    const service = new NodeTcpHistoryService(db as never, { record } as never);
    await service.save(uuid, 'Нода проверки', report);
    expect(rows[0]?.key).toContain(`checkhost.node.${uuid}.`);
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'remnawave.tcp.checked',
        target: { type: 'node', id: uuid, display: 'Нода проверки' },
        metadata: expect.objectContaining({ verdict: 'unknown' }),
      }),
    );
    const fresh = new NodeTcpHistoryService(db as never, { record } as never);
    const history = await fresh.list(uuid);
    expect(history.checks).toHaveLength(1);
    expect(history.checks[0]?.report).toEqual(report);
  });
});
