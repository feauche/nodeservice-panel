import { BadRequestException } from '@nestjs/common';
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

describe('BS Checker: аренда и точки WebSocket читаются по одной', () => {
  it('одна точка в незнакомом виде не прячет остальные — она считается непрочитанной', async () => {
    const { service, request } = fixture();
    request.mockResolvedValue({ rentals: [rental, { id: 'x', weird: true }] });
    expect(await service.list()).toMatchObject({ rentals: [{ id: '1' }], unreadable: 1 });
    const ws = {
      id: 41,
      name: 'WS-41',
      address: 'ws41.bsbord.com',
      state: 'active',
      tier: { code: 'p300', label: '300 Мбит/с' },
      mbit: 300,
      traffic: { unlimited: true, used_gb: 12.5 },
      expires_at: '2026-10-30T00:00:00+00:00',
      autorenew: { enabled: true, days: 30 },
      applied: true,
      ready: true,
      balancing: 'weighted',
      exits: [
        {
          host: '177.3.216.253',
          ip: '177.3.216.253',
          port: 443,
          weight: 50,
          backup: false,
          enabled: true,
          state: 'up',
        },
      ],
      bridges: ['91.240.12.7', '91.240.12.8'],
      cert: { issued: '2026-10-12T00:00:00+00:00', expires_at: '2027-01-10T00:00:00+00:00' },
    };
    request.mockResolvedValue({ ws: [ws, { nope: 1 }] });
    const list = await service.wsList();
    expect(list.unreadable).toBe(1);
    expect(list.ws[0]).toMatchObject({
      id: '41',
      name: 'WS-41',
      mbit: 300,
      bridges: ['91.240.12.7', '91.240.12.8'],
    });
    expect(request).toHaveBeenLastCalledWith('/ws');
  });
  it('окончательный отказ при смене выходов — понятная ошибка, правку можно повторить (не «неизвестно»)', async () => {
    const { service, request } = fixture();
    const p = await service.prepare('1', [{ ...target, host: '9.9.9.9' }]);
    request.mockImplementation(async (_path: string, _body: unknown, key?: string) => {
      if (!key) return rental;
      throw new BadRequestException('Адрес в блок-листе BS Checker.');
    });
    await expect(service.execute(p.id)).rejects.toThrow('Адрес в блок-листе BS Checker.');
    // Не запертое изменение: повтор снова отправляет его, а не отвечает «результат неизвестен».
    request.mockImplementation(async (_path: string, _body: unknown, key?: string) =>
      key ? { changed: true, apply: { version: 2 }, warnings: [] } : rental,
    );
    expect((await service.execute(p.id)).status).toBe('submitted');
  });
  it('серверы WebSocket: нужен включённый основной, без запасных при закреплении, без порта 22 и повторов', async () => {
    const { service, request } = fixture();
    const ws = { id: 41, name: 'WS-41', state: 'active', balancing: 'sticky', exits: [], bridges: [] };
    request.mockResolvedValue(ws);
    const exit = {
      host: '8.8.8.8',
      port: 443,
      weight: 1,
      max_connections: null,
      backup: false,
      enabled: true,
    };
    await expect(service.wsPrepare('41', { exits: [{ ...exit, enabled: false }] })).rejects.toThrow(
      'включённый основной',
    );
    await expect(
      service.wsPrepare('41', { exits: [exit, { ...exit, host: '9.9.9.9', backup: true }] }),
    ).rejects.toThrow('запасные не используются');
    await expect(service.wsPrepare('41', { exits: [{ ...exit, port: 22 }] })).rejects.toThrow('Порт 22');
    await expect(service.wsPrepare('41', { exits: [exit, exit] })).rejects.toThrow('не должны повторяться');
    const ok = await service.wsPrepare('41', { exits: [exit], balancing: 'weighted' });
    expect(ok).toMatchObject({ wsId: '41', after: [exit] });
  });
});
