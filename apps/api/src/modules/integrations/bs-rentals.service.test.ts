import { describe, expect, it, vi } from 'vitest';
import { BsRentalsService } from './bs-rentals.service.js';

const target = { host: '8.8.8.8', port: 443, weight: 1, backup: false };
const rental = {
  id: '1',
  endpoint: '1.1.1.1:443',
  proto: 'tcp',
  status: 'active',
  expires_at: null,
  tier: { code: 'basic', label: 'Basic' },
  targets: [target],
  traffic: { unlimited: true, quota_gb: null, used_gb: 0, left_gb: null, used_pct: null },
  config: { desired_version: 1, applied_version: 1, in_sync: true, node_online: true },
  health: { up: true, active: 'primary', checked_at: null },
  can_check: true,
};
function fixture() {
  let value = '';
  const db = {
    query: { appMeta: { findFirst: async () => (value ? { value } : null) } },
    insert: () => ({
      values: (v: { value: string }) => ({
        onConflictDoUpdate: async () => {
          value = v.value;
        },
      }),
    }),
  };
  const request = vi.fn().mockResolvedValue(rental);
  const service = new BsRentalsService(
    db as never,
    { rentalRequest: request } as never,
    { identity: async () => 'key-1' } as never,
  );
  return { service, request };
}
describe('BS Checker: изменения арендованных выходов', () => {
  it('не пишет провайдеру до подтверждения и не принимает неправильный состав', async () => {
    const { service, request } = fixture();
    await expect(service.prepare('1', [{ ...target, backup: true }])).rejects.toThrow();
    await expect(service.prepare('1', [target, target])).rejects.toThrow();
    const p = await service.prepare('1', [{ ...target, host: '9.9.9.9' }]);
    expect(p.before).toEqual([target]);
    expect(request.mock.calls.every((c) => c.length === 1)).toBe(true);
  });
  it('не перезаписывает изменение другого администратора', async () => {
    const { service, request } = fixture();
    const p = await service.prepare('1', [{ ...target, host: '9.9.9.9' }]);
    request.mockResolvedValue({ ...rental, targets: [{ ...target, host: '4.4.4.4' }] });
    await expect(service.execute(p.id)).rejects.toThrow('Адреса уже изменились');
    expect(request.mock.calls.every((c) => c.length === 1)).toBe(true);
  });
  it('потерянный ответ повторяет полный список с тем же ключом; успешный ответ кэшируется', async () => {
    const { service, request } = fixture();
    const p = await service.prepare('1', [{ ...target, host: '9.9.9.9' }]);
    request.mockImplementation(async (_path: string, _body: unknown, key?: string) => {
      if (!key) return rental;
      throw Error('lost');
    });
    expect((await service.execute(p.id)).status).toBe('uncertain');
    request.mockResolvedValue({ changed: true, apply: { version: 2 }, warnings: [] });
    expect((await service.execute(p.id)).status).toBe('submitted');
    const puts = request.mock.calls.filter((c) => c[3] === 'PUT');
    expect(puts).toHaveLength(2);
    expect(puts[0]).toEqual(puts[1]);
    expect(puts[0]?.[2]).toBe(p.id);
    await service.execute(p.id);
    expect(request.mock.calls.filter((c) => c[3] === 'PUT')).toHaveLength(2);
  });
  it('отклоняет небезопасный id и получает ожидающий результат через GET', async () => {
    const { service, request } = fixture();
    await expect(service.get('../account')).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
    request.mockResolvedValue({ check: { id: 'check-1', status: 'done', results: [] } });
    expect(await service.checkResult('1', 'check-1')).toEqual({ id: 'check-1', status: 'done', results: [] });
    expect(request).toHaveBeenCalledWith('/rentals/1/check/check-1');
  });
});
