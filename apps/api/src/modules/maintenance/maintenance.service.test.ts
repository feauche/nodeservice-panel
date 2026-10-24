import type { NodeMaintenance } from '@nodeservice/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NodeMaintenanceService } from './maintenance.service.js';

const NODE = { uuid: '11111111-1111-4111-8111-111111111111', name: 'Германия - 1', isConnected: false };

function setup(opts: { nodes?: Array<typeof NODE>; hide?: () => Promise<unknown> } = {}) {
  const records = new Map<string, NodeMaintenance>();
  const order: string[] = [];
  const store = {
    all: async () => new Map(records),
    get: async (_d: string, uuid: string) => records.get(uuid) ?? null,
    put: vi.fn(async (_d: string, m: NodeMaintenance) => {
      order.push('put');
      records.set(m.nodeUuid, m);
      return m;
    }),
    remove: vi.fn(async (_d: string, uuid: string) => {
      const old = records.get(uuid) ?? null;
      records.delete(uuid);
      return old;
    }),
  };
  const remna = { status: async () => ({ domain: 'panel', error: null, nodes: opts.nodes ?? [NODE] }) };
  const scenarios = {
    hideForMaintenance: vi.fn(
      opts.hide ??
        (async () => {
          order.push('hide');
          return { hidden: ['Германия', 'Германия | Hysteria2'], shared: 1, error: null };
        }),
    ),
    restoreAfterMaintenance: vi.fn(async () => ({ restored: ['Германия'], failed: [] })),
    maintenancePreview: vi.fn(),
  };
  const incidents = {
    closeForMaintenance: vi.fn(async () => {
      order.push('close');
      return 2;
    }),
  };
  const audit = { extend: vi.fn(), record: vi.fn(async () => null) };
  const service = new NodeMaintenanceService(
    store as never,
    remna as never,
    scenarios as never,
    incidents as never,
    audit as never,
  );
  return { service, records, store, scenarios, incidents, audit, order };
}

afterEach(() => vi.useRealTimers());

describe('Обслуживание ноды: включение', () => {
  it('на час: запись сохраняется раньше, чем закрываются события и скрываются Host; итог Host — в записи', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.parse('2026-10-15T08:40:00.000Z'));
    const t = setup();
    const m = await t.service.start(NODE.uuid, { minutes: 60, reason: 'Обновляю ядро', hideHosts: true });
    expect(t.order).toEqual(['put', 'close', 'hide', 'put']);
    expect(m).toMatchObject({
      nodeName: 'Германия - 1',
      until: '2026-10-15T09:40:00.000Z',
      reason: 'Обновляю ядро',
      hideHosts: true,
      hosts: { hidden: ['Германия', 'Германия | Hysteria2'], shared: 1, error: null },
    });
    expect(t.audit.extend).toHaveBeenCalledWith(
      expect.objectContaining({
        target: { type: 'node', id: NODE.uuid, display: 'Германия - 1' },
        metadata: expect.objectContaining({
          term: '1 час',
          closedEvents: 2,
          hiddenHosts: ['Германия', 'Германия | Hysteria2'],
        }),
      }),
    );
  });

  it('без срока и без Host: Host не трогаются, «до выключения»', async () => {
    const t = setup();
    const m = await t.service.start(NODE.uuid, { minutes: null, reason: '', hideHosts: false });
    expect(m.until).toBeNull();
    expect(t.scenarios.hideForMaintenance).not.toHaveBeenCalled();
    expect(t.audit.extend.mock.calls[0]?.[0].metadata.term).toBe('до выключения');
  });

  it('Remnawave не дала отключить Host — обслуживание всё равно включено, причина словами', async () => {
    const t = setup({
      hide: async () => {
        throw new Error('Нет права «Изменение Host»');
      },
    });
    const m = await t.service.start(NODE.uuid, { minutes: 30, reason: '', hideHosts: true });
    expect(t.records.has(NODE.uuid)).toBe(true);
    expect(m.hosts).toEqual({
      hidden: [],
      shared: 0,
      error: 'Host не отключены: Нет права «Изменение Host»',
    });
  });

  it('повторное включение идущего: срок и причина новые, начало прежнее, Host второй раз не скрываются', async () => {
    const t = setup();
    const first = await t.service.start(NODE.uuid, { minutes: 30, reason: 'а', hideHosts: true });
    const second = await t.service.start(NODE.uuid, { minutes: 180, reason: 'б', hideHosts: true });
    expect(t.scenarios.hideForMaintenance).toHaveBeenCalledTimes(1);
    expect(second.startedAt).toBe(first.startedAt);
    expect(second.reason).toBe('б');
    expect(second.hosts?.hidden).toEqual(['Германия', 'Германия | Hysteria2']);
  });

  it('ноды нет в Remnawave — понятная ошибка, ничего не сохраняется', async () => {
    const t = setup({ nodes: [] });
    await expect(t.service.start(NODE.uuid, { minutes: 60, reason: '', hideHosts: false })).rejects.toThrow(
      'Нода не найдена в Remnawave.',
    );
    expect(t.store.put).not.toHaveBeenCalled();
  });
});

describe('Обслуживание ноды: продление и окончание', () => {
  it('+1 час — от срока; если срок уже прошёл — от сейчас; без срока остаётся без срока', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.parse('2026-10-15T09:00:00.000Z'));
    const t = setup();
    await t.service.start(NODE.uuid, { minutes: 30, reason: '', hideHosts: false });
    expect((await t.service.extend(NODE.uuid)).until).toBe('2026-10-15T10:30:00.000Z');
    await t.service.start(NODE.uuid, { minutes: null, reason: '', hideHosts: false });
    expect((await t.service.extend(NODE.uuid)).until).toBeNull();
  });

  it('продлить или закончить то, что не идёт, — понятная ошибка', async () => {
    const t = setup();
    await expect(t.service.extend(NODE.uuid)).rejects.toThrow('Обслуживание этой ноды не идёт.');
    await expect(t.service.end(NODE.uuid)).rejects.toThrow('Обслуживание этой ноды не идёт.');
  });

  it('закончить кнопкой: запись убрана, скрытые Host возвращаются, итог — в «Журнал»', async () => {
    const t = setup();
    await t.service.start(NODE.uuid, { minutes: 60, reason: '', hideHosts: true });
    const r = await t.service.end(NODE.uuid);
    expect(t.records.has(NODE.uuid)).toBe(false);
    expect(t.scenarios.restoreAfterMaintenance).toHaveBeenCalledWith(NODE.uuid);
    expect(r).toMatchObject({ restored: ['Германия'], failed: [] });
    expect(t.audit.extend.mock.calls.at(-1)?.[0].metadata).toEqual({
      restoredHosts: ['Германия'],
      hostsFailed: [],
    });
  });

  it('срок вышел — заканчивается само от имени панели; Host без «Отключить Host» не трогаются', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.parse('2026-10-15T09:00:00.000Z'));
    const t = setup();
    await t.service.start(NODE.uuid, { minutes: 30, reason: 'Ядро', hideHosts: false });
    await t.service.expire(Date.parse('2026-10-15T09:29:00.000Z'));
    expect(t.records.has(NODE.uuid)).toBe(true);
    await t.service.expire(Date.parse('2026-10-15T09:31:00.000Z'));
    expect(t.records.has(NODE.uuid)).toBe(false);
    expect(t.scenarios.restoreAfterMaintenance).not.toHaveBeenCalled();
    expect(t.audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'incident.node_maintenance.expired',
        actor: expect.objectContaining({ type: 'system' }),
        target: { type: 'node', id: NODE.uuid, display: 'Германия - 1' },
      }),
    );
  });

  it('нода исчезла из Remnawave — запись просто убирается', async () => {
    const t = setup();
    await t.service.start(NODE.uuid, { minutes: null, reason: '', hideHosts: true });
    const gone = setup({ nodes: [] });
    gone.records.set(NODE.uuid, t.records.get(NODE.uuid) as NodeMaintenance);
    await gone.service.expire();
    expect(gone.records.size).toBe(0);
    expect(gone.scenarios.restoreAfterMaintenance).not.toHaveBeenCalled();
    expect(gone.audit.record).not.toHaveBeenCalled();
  });
});
