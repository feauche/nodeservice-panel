import { afterEach, describe, expect, it, vi } from 'vitest';

import { HttpRemnawaveClient, RemnawaveApiError } from './remnawave-client.js';

describe('HttpRemnawaveClient.fetch', () => {
  afterEach(() => vi.unstubAllGlobals());

  const respond = (byUrl: Record<string, unknown>) =>
    vi.fn(async (url: string) => {
      const hit = Object.entries(byUrl).find(([k]) => url.includes(k));
      if (!hit) throw new Error(`неожиданный запрос: ${url}`);
      const [, body] = hit;
      if ((body as { __status?: number }).__status)
        return new Response('', { status: (body as { __status: number }).__status });
      return new Response(JSON.stringify(body), { status: 200 });
    });

  it('собирает сводку, ноды и число онлайн по ноде из трёх запросов; версия из metadata', async () => {
    vi.stubGlobal(
      'fetch',
      respond({
        '/api/system/stats': {
          response: {
            uptime: 86400,
            users: { totalUsers: 870, statusCounts: { ACTIVE: 800, DISABLED: 40, LIMITED: 10, EXPIRED: 20 } },
            onlineStats: { onlineNow: 236, lastDay: 500, lastWeek: 700, neverOnline: 10 },
            nodes: { totalOnline: 1, totalBytesLifetime: '20000000000000' },
          },
        },
        '/api/nodes': {
          response: [
            {
              uuid: 'n1',
              name: 'bridge',
              address: '104.171.133.254',
              countryCode: 'PL',
              isConnected: true,
              isDisabled: false,
              isConnecting: false,
              lastStatusMessage: null,
              trafficUsedBytes: 1000,
              trafficLimitBytes: null,
            },
          ],
        },
        '/api/system/nodes/metrics': { response: { nodes: [{ nodeUuid: 'n1', usersOnline: 42 }] } },
        '/api/system/metadata': { response: { version: '2.1.10' } },
      }),
    );
    const r = await new HttpRemnawaveClient().fetch('vpn-panel.example.com', 'rw_pat_x');
    expect(r.stats).toMatchObject({
      users: { total: 870, active: 800, disabled: 40, limited: 10, expired: 20 },
      online: { now: 236, lastDay: 500, lastWeek: 700, never: 10 },
      nodesOnline: 1,
      nodesTotal: 1,
      trafficBytesLifetime: '20000000000000',
      panelVersion: '2.1.10',
      panelUptimeSec: 86400,
    });
    expect(r.nodes).toEqual([
      {
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
      },
    ]);
  });

  it('нода без метрик получает usersOnline: null, а не 0', async () => {
    vi.stubGlobal(
      'fetch',
      respond({
        '/api/system/stats': {
          response: { uptime: 1, users: { totalUsers: 0, statusCounts: {} }, onlineStats: {}, nodes: {} },
        },
        '/api/nodes': {
          response: [
            {
              uuid: 'n2',
              name: 'x',
              address: '1.2.3.4',
              isConnected: false,
              isDisabled: true,
              isConnecting: false,
            },
          ],
        },
        '/api/system/nodes/metrics': { response: { nodes: [] } },
        '/api/system/metadata': { response: { version: '2.0.0' } },
      }),
    );
    const r = await new HttpRemnawaveClient().fetch('x.example.com', 'k');
    expect(r.nodes[0]).toMatchObject({ usersOnline: null, countryCode: null, isDisabled: true });
  });

  it('401 даёт RemnawaveApiError(unauthorized), сетевой сбой — unreachable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('', { status: 401 })),
    );
    await expect(new HttpRemnawaveClient().fetch('x.example.com', 'bad')).rejects.toMatchObject({
      kind: 'unauthorized',
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('ECONNREFUSED');
      }),
    );
    const err = await new HttpRemnawaveClient().fetch('x.example.com', 'k').catch((e) => e);
    expect(err).toBeInstanceOf(RemnawaveApiError);
    expect(err.kind).toBe('unreachable');
  });

  it('500 и не-JSON тело — unreachable, с сохранением текста ошибки', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('oops', { status: 500 })),
    );
    const err = await new HttpRemnawaveClient().fetch('x.example.com', 'k').catch((e) => e);
    expect(err.kind).toBe('unreachable');
    expect(err.message).toContain('500');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('<html>не json</html>', { status: 200 })),
    );
    const err2 = await new HttpRemnawaveClient().fetch('x.example.com', 'k').catch((e) => e);
    expect(err2.kind).toBe('unreachable');
  });
});

describe('HttpRemnawaveClient.checkCertificate', () => {
  it('в тестовом окружении не подключается по TLS, статус unknown', async () => {
    const c = await new HttpRemnawaveClient().checkCertificate('example.com');
    expect(c).toMatchObject({ status: 'unknown' });
  });
});
