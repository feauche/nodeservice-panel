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
