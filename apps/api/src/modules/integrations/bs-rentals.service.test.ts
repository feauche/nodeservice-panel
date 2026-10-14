import { BadRequestException, HttpException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { errorText } from '../../common/filters/problem-details.filter.js';
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
describe('BS Checker: ответ сервиса в незнакомом виде', () => {
  // Вид ответа /v1/ws/{id}/connect на 13.10.2026: проверка и откат — по инструменту, у проверки есть «снаружи».
  const connect = {
    id: 5,
    name: 'WS-5',
    address: 'radio.example',
    host: {
      address: 'radio.example',
      port: 443,
      security: 'tls',
      network: 'ws',
      alpn: ['http/1.1'],
      mux: { enabled: true, concurrency: 8 },
    },
    inbound_ready: true,
    inbound_wait: null,
    inbound_port: 441,
    inbound: { port: 441, protocol: 'vless' },
    inbound_by_port: [],
    bridges: ['91.240.12.7'],
    firewall: {
      ips: ['91.240.12.7'],
      by_port: [
        {
          port: 441,
          exits: ['2.26.101.44'],
          ips: ['91.240.12.7'],
          nftables: 'systemctl restart wsin-441',
          ufw: 'ufw allow from 91.240.12.7 to any port 441 proto tcp',
          allow: { ufw: 'ufw allow from 91.240.12.7', firewalld: 'firewall-cmd --reload' },
          check: {
            nftables: 'nft list table inet wsin_441',
            ufw: 'ufw status numbered | grep -w 441',
            outside: 'nc -vz -w 5 2.26.101.44 441',
          },
          rollback: { nftables: 'systemctl disable --now wsin-441', ufw: 'ufw delete deny 441/tcp' },
        },
      ],
    },
    cert: { issued: true, expires_at: '2027-01-10T00:00:00Z', names: ['radio.example'] },
  };
  it('настройки подключения: проверка и откат по инструменту читаются', async () => {
    const { service, request } = fixture();
    request.mockResolvedValue(connect);
    const c = await service.wsConnect('5');
    expect(c.firewall?.by_port[0]).toMatchObject({
      check: { ufw: 'ufw status numbered | grep -w 441', outside: 'nc -vz -w 5 2.26.101.44 441' },
      rollback: { nftables: 'systemctl disable --now wsin-441', ufw: 'ufw delete deny 441/tcp' },
    });
    expect(request).toHaveBeenLastCalledWith('/ws/5/connect');
  });
  it('незнакомый вид — «формат изменился» (502), а не «проверьте поля» с английским текстом разбора', async () => {
    const { service, request } = fixture();
    const reject = async (call: Promise<unknown>) => {
      const e = await call.then(
        () => null,
        (err: unknown) => err,
      );
      expect(e).toBeInstanceOf(HttpException);
      expect((e as HttpException).getStatus()).toBe(502);
      return errorText(e);
    };
    request.mockResolvedValue({ ...connect, firewall: { by_port: 'не список' } });
    expect(await reject(service.wsConnect('5'))).toBe(
      'Формат настроек подключения BS Checker изменился — панель не смогла их прочитать.',
    );
    request.mockResolvedValue({ id: 5, exits: 'не список' });
    expect(await reject(service.wsGet('5'))).toBe(
      'Формат точки WebSocket BS Checker изменился — панель не смогла её прочитать.',
    );
    request.mockResolvedValue({ id: '1', targets: 'не список' });
    expect(await reject(service.get('1'))).toBe(
      'Формат точки аренды BS Checker изменился — панель не смогла её прочитать.',
    );
  });
});

/** Хранилище с ключами: изменения точки, отметки о записанной проверке — как в app_meta. */
function wsFixture(ws: Record<string, unknown>) {
  const store = new Map<string, string>();
  const db = {
    query: {
      appMeta: {
        findFirst: async (q: { where: { queryChunks?: Array<{ value?: unknown }> } }) => {
          // where: eq(appMeta.key, 'ключ') — значение ключа лежит в параметре выражения
          const key = q.where.queryChunks?.find((c) => typeof c?.value === 'string')?.value as
            | string
            | undefined;
          const value = key === undefined ? undefined : store.get(key);
          return value === undefined ? null : { value };
        },
      },
    },
    insert: () => ({
      values: (v: { key: string; value: string }) => ({
        onConflictDoUpdate: async () => void store.set(v.key, v.value),
      }),
    }),
  };
  const recorded: Record<string, unknown>[] = [];
  const audit = {
    record: async (e: Record<string, unknown>) => void recorded.push(e),
    extend: vi.fn(),
  };
  const request = vi.fn().mockImplementation(async () => ws);
  const service = new BsRentalsService(
    db as never,
    { rentalRequest: request } as never,
    { identity: async () => 'key-1' } as never,
    audit as never,
  );
  return { service, store, recorded, audit, request };
}
const wsBase = {
  id: '5',
  name: 'WS-5',
  state: 'active',
  applied: true,
  exits: [
    { host: '1.1.1.1', port: 441, backup: false, enabled: true, state: 'up' },
    { host: '2.2.2.2', port: 441, backup: false, enabled: true, state: 'up' },
  ],
};

describe('BS Checker: проверка серверов точки после сохранения', () => {
  const submitted = (wsId = '5') =>
    JSON.stringify({
      identity: 'key-1',
      wsId,
      before: [],
      after: [],
      expiresAt: 'x',
      started: true,
      result: { status: 'submitted', applied: true, warnings: [] },
    });

  it('пока сервер «неизвестно» — итог не готов и в Журнал не пишется', async () => {
    const { service, store, recorded } = wsFixture({
      ...wsBase,
      exits: [
        ...wsBase.exits,
        { host: '3.3.3.3', port: 441, backup: false, enabled: true, state: 'unknown' },
      ],
    });
    store.set('bschecker.ws-change.11111111-1111-4111-8111-111111111111', submitted());
    const r = await service.wsVerify('5', '11111111-1111-4111-8111-111111111111');
    expect(r).toMatchObject({ done: false, total: 3, working: 2, pending: 1, failing: [] });
    expect(recorded).toHaveLength(0);
  });

  it('итог готов: пишется в Журнал; тот же итог повторно — нет, другой (сервер починили) — да', async () => {
    const { service, store, recorded, request } = wsFixture({
      ...wsBase,
      exits: [...wsBase.exits, { host: '3.3.3.3', port: 441, backup: false, enabled: true, state: 'down' }],
    });
    const changeId = '22222222-2222-4222-8222-222222222222';
    store.set(`bschecker.ws-change.${changeId}`, submitted());
    const r = await service.wsVerify('5', changeId);
    expect(r).toMatchObject({ done: true, working: 2, failing: ['3.3.3.3:441'] });
    await service.wsVerify('5', changeId);
    expect(recorded).toHaveLength(1);
    request.mockResolvedValue({
      ...wsBase,
      exits: [...wsBase.exits, { host: '3.3.3.3', port: 441, backup: false, enabled: true, state: 'up' }],
    });
    await service.wsVerify('5', changeId);
    await service.wsVerify('5', changeId);
    expect(recorded).toHaveLength(2);
    expect(recorded[1]).toMatchObject({ result: 'ok', metadata: { total: 3, working: 3, failing: [] } });
    expect(recorded[0]).toMatchObject({
      action: 'integration.bs.ws_exits_verified',
      result: 'failed',
      target: { type: 'bs_ws', id: '5' },
      metadata: { total: 3, working: 2, failing: ['3.3.3.3:441'] },
    });
  });

  it('чужое изменение, чужая точка и выдуманный номер в Журнал не попадают', async () => {
    const { service, store, recorded } = wsFixture(wsBase);
    store.set('bschecker.ws-change.33333333-3333-4333-8333-333333333333', submitted('9'));
    expect((await service.wsVerify('5', '33333333-3333-4333-8333-333333333333')).done).toBe(true);
    await service.wsVerify('5', '44444444-4444-4444-8444-444444444444');
    await service.wsVerify('5', 'не-номер');
    expect(recorded).toHaveLength(0);
  });

  it('выключенный сервер в проверке не участвует; точка ещё применяет изменение — итога нет', async () => {
    const { service } = wsFixture({
      ...wsBase,
      applied: false,
      exits: [
        ...wsBase.exits,
        { host: '3.3.3.3', port: 441, backup: false, enabled: false, state: 'disabled' },
      ],
    });
    const r = await service.wsVerify('5');
    expect(r.total).toBe(2);
    expect(r.done).toBe(false);
  });
});
