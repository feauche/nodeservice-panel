import { HttpException } from '@nestjs/common';
import type { RemnawaveCert, RemnawaveNode, RemnawaveStats } from '@nodeservice/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RemnawaveService } from './remnawave.service.js';
import type { RemnawaveFetched } from './remnawave-client.js';
import { RemnawaveApiError } from './remnawave-client.js';

const STATS: RemnawaveStats = {
  users: { total: 870, active: 800, disabled: 40, limited: 10, expired: 20 },
  online: { now: 236, lastDay: 500, lastWeek: 700, never: 10 },
  nodesOnline: 4,
  nodesTotal: 5,
  trafficBytesLifetime: '20000000000000',
  panelVersion: '2.1.10',
  panelUptimeSec: 86_400,
};
const NODE = (over: Partial<RemnawaveNode> = {}): RemnawaveNode => ({
  uuid: 'n1',
  name: 'bridge',
  address: '104.171.133.254',
  countryCode: 'PL',
  isConnected: true,
  isDisabled: false,
  isConnecting: false,
  lastStatusMessage: null,
  usersOnline: 42,
  trafficUsedBytes: 1000,
  trafficLimitBytes: null,
  ...over,
});
const CERT: RemnawaveCert = { status: 'ok', expiresAt: '2026-12-01T00:00:00.000Z', daysLeft: 60, note: null };

function make() {
  const rows = new Map<string, unknown>();
  const audit: Array<Record<string, unknown>> = [];
  const notifications: Array<Record<string, unknown>> = [];
  const world = {
    fetchResult: { stats: STATS, nodes: [NODE()] } as RemnawaveFetched,
    fetchError: null as Error | null,
    cert: CERT,
    fetchCalls: 0,
  };
  const store = {
    async load() {
      return rows.get('row');
    },
    async domain() {
      return (rows.get('row') as { domain: string } | undefined)?.domain ?? null;
    },
    async snapshot() {
      return (rows.get('row') as { snapshot: unknown } | undefined)?.snapshot ?? null;
    },
    async credentials() {
      const r = rows.get('row') as { domain: string; apiKey: string } | undefined;
      return r ? { domain: r.domain, apiKey: r.apiKey } : null;
    },
    async connect(domain: string, apiKey: string, snapshot: unknown) {
      rows.set('row', { domain, apiKey, snapshot });
    },
    async updateSnapshot(snapshot: unknown) {
      const r = rows.get('row') as { domain: string; apiKey: string } | undefined;
      if (r) rows.set('row', { ...r, snapshot });
    },
    async disconnect() {
      rows.delete('row');
    },
  };
  const client = {
    async fetch() {
      world.fetchCalls += 1;
      if (world.fetchError) throw world.fetchError;
      return world.fetchResult;
    },
    async checkCertificate() {
      return world.cert;
    },
  };
  const svc = new RemnawaveService(
    store as never,
    client as never,
    { record: async (e: Record<string, unknown>) => void audit.push(e) } as never,
    { get: () => 'http://victoriametrics:8428' } as never,
    { push: async (e: Record<string, unknown>) => void notifications.push(e) } as never,
    { status: async () => ({ configured: false, routes: null, routeDetails: [] }) } as never,
  );
  return { svc, world, audit, notifications };
}

afterEach(() => vi.useRealTimers());

describe('RemnawaveService: подключение', () => {
  let ctx: ReturnType<typeof make>;
  beforeEach(() => {
    ctx = make();
  });

  it('не подключено: статус пустой, ничего не запрашивается', async () => {
    const s = await ctx.svc.status();
    expect(s).toEqual({
      connected: false,
      domain: null,
      checkedAt: null,
      lastAttemptAt: null,
      error: null,
      stats: null,
      nodes: [],
      cert: null,
      vpnProbeConfigured: false,
      vpnProbeRoutes: null,
      vpnProbeRouteDetails: [],
    });
  });

  it('успешное подключение: сохраняет домен без протокола, данные и сертификат, пишет в Журнал', async () => {
    const s = await ctx.svc.connect({ domain: 'vpn-panel.example.com', apiKey: 'rw_pat_x' });
    expect(s).toMatchObject({ connected: true, domain: 'vpn-panel.example.com', error: null, cert: CERT });
    expect(s.stats).toEqual(STATS);
    expect(s.nodes).toEqual([NODE()]);
    expect(s.checkedAt).not.toBeNull();
    expect(ctx.audit).toHaveLength(1);
    expect(ctx.audit[0]).toMatchObject({
      action: 'remnawave.connected',
      target: { type: 'settings', id: 'remnawave', display: 'vpn-panel.example.com' },
      metadata: { domain: 'vpn-panel.example.com', nodes: 1, users: 870 },
    });
  });

  it('неверный токен: 400 с понятным текстом, ничего не сохраняется', async () => {
    ctx.world.fetchError = new RemnawaveApiError('Remnawave ответила «доступ запрещён».', 'unauthorized');
    await expect(ctx.svc.connect({ domain: 'x.example.com', apiKey: 'bad' })).rejects.toMatchObject({
      status: 400,
    });
    expect((await ctx.svc.status()).connected).toBe(false);
    expect(ctx.audit).toEqual([]);
  });

  it('домен не отвечает: 502, ничего не сохраняется', async () => {
    ctx.world.fetchError = new RemnawaveApiError('не отвечает', 'unreachable');
    await expect(ctx.svc.connect({ domain: 'x.example.com', apiKey: 'k' })).rejects.toMatchObject({
      status: 502,
    });
    expect((await ctx.svc.status()).connected).toBe(false);
  });

  it('refresh без подключения — 409; после подключения обновляет снимок свежими данными', async () => {
    await expect(ctx.svc.refresh()).rejects.toMatchObject({ status: 409 });
    await ctx.svc.connect({ domain: 'x.example.com', apiKey: 'k' });
    ctx.world.fetchResult = {
      stats: { ...STATS, online: { ...STATS.online, now: 300 } },
      nodes: [NODE({ usersOnline: 50 })],
    };
    const s = await ctx.svc.refresh();
    expect(s.stats?.online.now).toBe(300);
    expect(s.nodes[0]?.usersOnline).toBe(50);
  });

  it('отключение стирает домен и токен, пишет в Журнал', async () => {
    await ctx.svc.connect({ domain: 'x.example.com', apiKey: 'k' });
    await ctx.svc.disconnect();
    expect(await ctx.svc.status()).toMatchObject({ connected: false });
    expect(ctx.audit.at(-1)).toMatchObject({ action: 'remnawave.disconnected' });
  });

  it('отключение без подключения ничего не пишет в Журнал', async () => {
    await ctx.svc.disconnect();
    expect(ctx.audit).toEqual([]);
  });
});

describe('RemnawaveService: тихая перепроверка (джоба)', () => {
  let ctx: ReturnType<typeof make>;
  beforeEach(async () => {
    ctx = make();
    await ctx.svc.connect({ domain: 'x.example.com', apiKey: 'k' });
  });

  it('без подключения ничего не делает', async () => {
    const fresh = make();
    await fresh.svc.syncQuiet();
    expect(fresh.world.fetchCalls).toBe(0);
  });

  it('успех: обновляет снимок молча, без записи в Журнал', async () => {
    ctx.world.fetchResult = { stats: { ...STATS, online: { ...STATS.online, now: 1 } }, nodes: [] };
    await ctx.svc.syncQuiet();
    expect((await ctx.svc.status()).stats?.online.now).toBe(1);
    expect(ctx.audit).toHaveLength(1); // только запись connect
  });

  it('первая неудача: сохраняет причину, не портит прежние данные, пишет предупреждение в Журнал один раз', async () => {
    const lastSuccess = (await ctx.svc.status()).checkedAt;
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-02T12:00:00.000Z'));
    ctx.world.fetchError = new HttpException({ detail: 'таймаут' }, 502) as unknown as Error;
    await ctx.svc.syncQuiet();
    let s = await ctx.svc.status();
    expect(s.error).toBe('таймаут');
    expect(s.error).not.toBe('Http Exception');
    expect(s.stats).toEqual(STATS); // прежние данные остались
    expect(s.checkedAt).toBe(lastSuccess); // время последнего успеха не подменяется попыткой
    expect(s.lastAttemptAt).toBe('2026-10-02T12:00:00.000Z');
    expect(ctx.audit.filter((a) => a.action === 'remnawave.unreachable')).toHaveLength(1);
    // повторная неудача не пишет второй раз
    await ctx.svc.syncQuiet();
    expect(ctx.audit.filter((a) => a.action === 'remnawave.unreachable')).toHaveLength(1);
    // восстановилось — пишет «снова на связи» один раз
    ctx.world.fetchError = null;
    await ctx.svc.syncQuiet();
    s = await ctx.svc.status();
    expect(s.error).toBeNull();
    expect(ctx.audit.filter((a) => a.action === 'remnawave.reconnected')).toHaveLength(1);
  });

  it('после пяти минут сбоя сообщает один раз и отдельно говорит о восстановлении', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-02T12:00:00.000Z'));
    ctx.world.fetchError = new HttpException({ detail: 'DNS не отвечает' }, 502) as unknown as Error;
    await ctx.svc.syncQuiet();
    expect(ctx.notifications).toEqual([]);

    vi.setSystemTime(new Date('2026-10-02T12:05:00.000Z'));
    await ctx.svc.syncQuiet();
    await ctx.svc.syncQuiet();
    expect(ctx.notifications).toHaveLength(1);
    expect(ctx.notifications[0]).toMatchObject({ severity: 'warn', title: 'Remnawave не отвечает' });

    ctx.world.fetchError = null;
    vi.setSystemTime(new Date('2026-10-02T12:06:00.000Z'));
    await ctx.svc.syncQuiet();
    expect(ctx.notifications).toHaveLength(2);
    expect(ctx.notifications[1]).toMatchObject({ severity: 'ok', title: 'Remnawave снова отвечает' });
  });
});
