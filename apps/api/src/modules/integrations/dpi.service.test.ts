import { HttpException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { DpiService, dpiPoint, parsePrices, parseProbePrice, subnet24 } from './dpi.service.js';

describe('DPI Checker: ответ точки по-русски', () => {
  it('Reality: сертификат другого имени при открытом порте — открывается, а не «недоступна»', () => {
    // Строка из примера 4033 документации DPI Checker.
    const p = dpiPoint({
      pop_name: 'Республика Карачаево-Черкесия',
      verdict: 'clean',
      accessible: false,
      error_code: 'tls_cert_other_name',
      port_443_state: 'open',
      ping_avg_ms: 1014.1,
      samples_total: 5,
      samples_tls_ok: 5,
      samples_throttled: 0,
      port_80_hijacked: true,
    });
    expect(p).toMatchObject({
      state: 'ok',
      accessible: true,
      reason: 'Сертификат другого имени — для Reality это норма',
      latency: 1014.1,
      tls: '5 из 5',
      throttled: '0 из 5',
      port80: 'перехвачен',
    });
  });
  it('«чисто» при открытом порте, но TLS не прошёл ни разу — не открывается (живой ответ по «США - 1»)', () => {
    expect(
      dpiPoint({
        accessible: false,
        verdict: 'clean',
        port_443_state: 'open',
        samples_total: 5,
        samples_tls_ok: 0,
        samples_throttled: 0,
      }),
    ).toMatchObject({ state: 'fail', reason: 'Порт открыт, TLS не проходит', tls: '0 из 5' });
    // Чужой сертификат при 0 удачных TLS — тоже не Reality, а отказ.
    expect(
      dpiPoint({
        accessible: false,
        error_code: 'tls_cert_other_name',
        port_443_state: 'open',
        samples_total: 5,
        samples_tls_ok: 0,
      }).state,
    ).toBe('fail');
  });
  it('точка без связи (прокси точки мёртв или контрольный сайт не открылся) — не в счёт', () => {
    expect(dpiPoint({ connected: false, proxy_dead: true }).state).toBe('unknown');
    expect(
      dpiPoint({ connected: false, control_check: { target: 'google.com', accessible: false } }),
    ).toMatchObject({
      state: 'unknown',
      accessible: null,
      reason: 'Точка сама без связи — не в счёт',
    });
  });
  it('причина отказа: сброс при TLS, нет ответа, порт закрыт; у VLESS задержка 0 — не число', () => {
    expect(dpiPoint({ accessible: false, error_code: 'tls_handshake_failed' }).reason).toBe(
      'Сброс при установке TLS',
    );
    expect(dpiPoint({ accessible: false, port_443_state: 'silent' }).reason).toBe('Нет ответа');
    expect(
      dpiPoint({ connected: false, error: 'curl exit 28 (соединение не установлено)', latency_ms: 0 }),
    ).toMatchObject({
      state: 'fail',
      reason: 'Нет ответа',
      latency: null,
    });
    expect(dpiPoint({ reached: false, status: 'refused' }).reason).toBe('Порт закрыт');
  });
});

describe('DPI Checker: проверка целиком', () => {
  const service = new DpiService({} as never, {} as never, {} as never);
  it('идущая проверка: статус active и ход «6 из 10», без точек — число точек из списка', () => {
    const c = service.normalize({
      id: 9520,
      status: 'active',
      check_type: 'ip',
      pop_count: 10,
      progress: { done: 6, total: 10, percent: 60 },
    });
    expect(c).toMatchObject({
      status: 'active',
      total: 10,
      success: null,
      progress: { done: 6, total: 10, percent: 60 },
    });
  });
  it('отменённая до начала — деньги вернули; точка без связи в итог не идёт', () => {
    expect(service.normalize({ id: 1, status: 'cancelled', usd_cost: 0.04 }).refunded).toBe(true);
    const c = service.normalize({
      id: 2,
      status: 'completed',
      results: [
        { accessible: true },
        { accessible: false },
        { connected: false, proxy_dead: true },
        { is_direct: true },
      ],
    });
    expect(c).toMatchObject({ total: 3, success: 1, unknown: 1 });
  });
  it('тарифы (живой ответ /tariffs): цены за точку и за адрес по режимам; непонятный ответ — null', () => {
    const tariffs = {
      currency: 'USD',
      locations: {
        russia: {
          ip: { popPrice: 0.003, resourcePrice: 0.001 },
          vpn: { popPrice: 0.008, resourcePrice: 0.002 },
          mtproto: { popPrice: 0.1, resourcePrice: 0.01 },
        },
      },
      probe: { fixed_usd: 1, traffic_usd_per_gb: 1.5 },
      noisy: { price_usd: 0, daily_limit: 10 },
    };
    expect(parsePrices(tariffs)).toEqual({
      ipPop: 0.003,
      ipResource: 0.001,
      vpnPop: 0.008,
      vpnResource: 0.002,
    });
    expect(parseProbePrice(tariffs)).toEqual({ fixed: 1, perGb: 1.5 });
    expect(parsePrices({ hello: 1 })).toBeNull();
    expect(subnet24('198.51.100.80')).toBe('198.51.100.0/24');
    expect(subnet24('2001:db8::1')).toBeNull();
  });
});

describe('DPI Checker: расписание не выключается из-за одной ноды', () => {
  function fixture(fail: (uuid: string) => unknown) {
    const rows = new Map<string, unknown>([
      [
        'dpi.schedule.id',
        {
          enabled: true,
          minutes: 60,
          nodes: ['a', 'b', 'c'],
          pops: [],
          nextAt: new Date(Date.now() - 1000).toISOString(),
          lastError: null,
          panel: 'panel.test',
        },
      ],
    ]);
    const service = new DpiService(
      {} as never,
      { session: async () => ({ identity: 'id', credentials: {} }) } as never,
      {
        status: async () => ({
          domain: 'panel.test',
          nodes: ['a', 'b', 'c'].map((uuid) => ({ uuid, name: `Нода ${uuid}` })),
        }),
      } as never,
    );
    const internals = service as unknown as {
      read: (k: string) => Promise<unknown>;
      write: (k: string, v: unknown) => Promise<void>;
    };
    internals.read = async (k) => structuredClone(rows.get(k) ?? null);
    internals.write = async (k, v) => {
      rows.set(k, structuredClone(v));
    };
    const started: string[] = [];
    vi.spyOn(service, 'start').mockImplementation(async (body) => {
      const error = fail(body.nodeUuid);
      if (error) throw error;
      started.push(body.nodeUuid);
      return {} as never;
    });
    return { service, rows, started };
  }
  const providerError = (code: string, detail: string) =>
    new HttpException({ detail, extensions: { providerCode: code } }, 502);
  it('не вышло для одной ноды — остальные проверяются, расписание остаётся включённым с причиной', async () => {
    const f = fixture((uuid) =>
      uuid === 'b' ? providerError('invalid_pops', 'Часть точек недоступна.') : null,
    );
    await f.service.runSchedule();
    expect(f.started).toEqual(['a', 'c']);
    expect(f.rows.get('dpi.schedule.id')).toMatchObject({
      enabled: true,
      lastError: 'Последний запуск — не для всех нод. Нода b: Часть точек недоступна.',
    });
  });
  it('нет денег — расписание останавливается с понятной причиной', async () => {
    const f = fixture(() =>
      providerError('insufficient_balance', 'Недостаточно средств на балансе DPI Checker.'),
    );
    await f.service.runSchedule();
    expect(f.started).toEqual([]);
    expect(f.rows.get('dpi.schedule.id')).toMatchObject({
      enabled: false,
      nextAt: null,
      lastError: 'Расписание остановлено: Недостаточно средств на балансе DPI Checker.',
    });
  });
});

describe('DPI Checker: список проверок — свежие первыми', () => {
  const at = (n: number) => new Date(Date.UTC(2026, 9, 1) + n * 60_000).toISOString();
  function fixture(total: number, oldestFirst: boolean) {
    const all = Array.from({ length: total }, (_, n) => ({ id: n + 1, status: 'failed', created_at: at(n) }));
    if (!oldestFirst) all.reverse();
    const requests: string[] = [];
    const service = new DpiService(
      {} as never,
      {
        providerRequest: async (_provider: string, path: string) => {
          if (path.startsWith('/pops')) return [];
          requests.push(path);
          const query = new URL(path, 'http://dpi.test').searchParams;
          const offset = Number(query.get('offset'));
          return { checks: all.slice(offset, offset + Number(query.get('limit'))) };
        },
      } as never,
      {} as never,
    );
    const internals = service as unknown as {
      read: () => Promise<null>;
      load: (session: unknown) => Promise<{ checks: { id: string }[] }>;
    };
    internals.read = async () => null;
    const load = () => internals.load({ identity: 'id', credentials: {} });
    return { all, requests, load };
  }
  const page = (offset: number) => `/checks?kind=check&limit=100&offset=${offset}`;

  it('новые первыми — хватает одной страницы', async () => {
    const f = fixture(250, false);
    const { checks } = await f.load();
    expect(checks).toHaveLength(100);
    expect(checks.slice(0, 3).map((c) => c.id)).toEqual(['250', '249', '248']);
    expect(f.requests).toEqual([page(0)]);
  });

  it('от старых к новым — дочитывает до конца, свежие сверху; в следующий раз — с запомненного места', async () => {
    const f = fixture(250, true);
    const first = await f.load();
    expect(first.checks).toHaveLength(100);
    expect([first.checks[0]?.id, first.checks.at(-1)?.id]).toEqual(['250', '151']);
    f.requests.length = 0;
    f.all.push({ id: 251, status: 'failed', created_at: at(250) });
    const second = await f.load();
    expect(second.checks[0]?.id).toBe('251');
    expect(f.requests).toEqual([page(0), page(100), page(200)]);
  });

  it('меньше сотни — одна страница, порядок по времени запуска', async () => {
    const f = fixture(3, true);
    const { checks } = await f.load();
    expect(checks.map((c) => c.id)).toEqual(['3', '2', '1']);
    expect(f.requests).toEqual([page(0)]);
  });
});

describe('DPI Checker: ключ VLESS из подписки служебного пользователя', () => {
  const NODE = '11111111-1111-4111-8111-111111111111';
  const LINK = 'vless://3f9a1b2c-0000-4000-8000-00000000c21e@de.example.com:443?type=tcp#Германия';
  function fixture(username: string | null, sub: unknown = null) {
    const sent: unknown[] = [];
    const service = new DpiService(
      {} as never,
      {
        providerRequest: async (_p: string, path: string, _m: string, body: unknown) => {
          sent.push(body);
          return path === '/checks/estimate' ? { estimated_cost: 0.1, balance: 5 } : {};
        },
        session: async () => ({ identity: 'id', credentials: {} }),
        setBalance: async () => undefined,
      } as never,
      {
        status: async () => ({
          connected: true,
          domain: 'panel.test',
          nodes: [{ uuid: NODE, name: 'Германия - 1', address: '45.12.8.20', isDisabled: false }],
        }),
        subscriptionKeys: async () =>
          sub ?? {
            found: true,
            user: { username, active: true, status: 'ACTIVE', expiresAt: null },
            entries: [
              {
                hostUuid: 'h1',
                address: 'de.example.com',
                port: 443,
                remark: 'Германия',
                protocol: 'vless',
                link: LINK,
              },
            ],
          },
      } as never,
      undefined,
      undefined,
      {
        get: async () => ({
          hosts: [{ id: 'h1', name: 'Германия', nodeUuids: [NODE], protocol: 'vless', disabled: false }],
        }),
      } as never,
    );
    (service as unknown as { read: (k: string) => Promise<unknown> }).read = async (k) =>
      k === 'dpi.key-user' && username ? { username } : null;
    return { service, sent };
  }
  const vpn = { nodeUuid: NODE, kind: 'vpn' as const, popIds: [39] };

  it('ключ не вставлен — берётся из подписки; в окно уходит только ключ со скрытым идентификатором', async () => {
    const f = fixture('nodeservice-check');
    await f.service.estimate(vpn);
    expect(f.sent[0]).toMatchObject({ check_type: 'vpn', keys: [LINK] });
    expect(await f.service.keyPreview(NODE)).toEqual({
      username: 'nodeservice-check',
      host: 'Германия',
      address: 'de.example.com',
      port: 443,
      shared: false,
      preview: 'vless://3f9a…c21e@de.example.com:443?type=tcp#Германия',
    });
  });

  it('вставленный ключ важнее подписки', async () => {
    const f = fixture('nodeservice-check');
    await f.service.estimate({ ...vpn, key: 'vless://own@x.example.com:443#Свой' });
    expect(f.sent[0]).toMatchObject({ keys: ['vless://own@x.example.com:443#Свой'] });
  });

  it('пользователь не задан, не найден или не активен — понятная причина, в DPI Checker ничего не уходит', async () => {
    await expect(fixture(null).service.estimate(vpn)).rejects.toThrow(
      'Вставьте ключ VLESS или укажите пользователя для ключей в «Подключении» DPI Checker.',
    );
    await expect(fixture('nobody', { found: false }).service.estimate(vpn)).rejects.toThrow(
      'Пользователя «nobody» нет в Remnawave.',
    );
    const expired = fixture('old', { found: true, user: { username: 'old', active: false }, entries: [] });
    await expect(expired.service.estimate(vpn)).rejects.toThrow(/не активен в Remnawave/);
    expect(expired.sent).toEqual([]);
  });

  it('настройка: по каждой ноде — Host, ключ которого возьмётся', async () => {
    expect(await fixture('nodeservice-check').service.keyUser()).toEqual({
      username: 'nodeservice-check',
      error: null,
      nodes: [{ uuid: NODE, name: 'Германия - 1', host: 'Германия', reason: null }],
    });
  });
});
