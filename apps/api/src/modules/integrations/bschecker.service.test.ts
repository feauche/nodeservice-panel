import { afterEach, describe, expect, it, vi } from 'vitest';
import { BsCheckerService } from './bschecker.service.js';

const unit = {
  op_key: 'exact-unit-1',
  operator: 'test',
  name: 'Тест',
  region: 'РФ',
  dpi: 'on',
  channel_state: 'ready',
  probeable: true,
};
function fixture() {
  const data = new Map<string, { key: string; value: string }>();
  const db = {
    query: {
      appMeta: { findFirst: async () => [...data.values()].at(-1), findMany: async () => [...data.values()] },
    },
    insert: () => ({
      values: (v: { key: string; value: string }) => ({
        onConflictDoUpdate: async () => {
          data.set(v.key, v);
        },
      }),
    }),
  };
  const integrations = {
    session: async () => ({ identity: 'credential-1', credentials: { apiKey: 'bsk_live_secret' } }),
    identity: async () => 'credential-1',
  };
  return { service: new BsCheckerService(db as never, integrations as never), data };
}
const input = { ip: '8.8.8.8', port: 443, operators: [unit.op_key], tcp: true, icmp: true };
const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status });
afterEach(() => vi.unstubAllGlobals());
describe('BS Checker: стоимость и повтор без второго списания', () => {
  it('передаёт домен в бесплатный расчёт и не принимает URL или локальную цель', async () => {
    const calls: { url: string; body?: string }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url, body: init.body as string | undefined });
        return json(url.includes('/operators') ? { units: [unit] } : { cost_credits: 25 });
      }),
    );
    const { service } = fixture();
    await service.preview({ ...input, ip: 'Example.COM' });
    expect(JSON.parse(String(calls[1]?.body))).toMatchObject({ target: 'example.com:443' });
    for (const ip of ['https://example.com/path', 'example.com:443', '127.0.0.1', 'node.local', 'localhost'])
      await expect(service.preview({ ...input, ip })).rejects.toThrow();
    expect(calls).toHaveLength(2);
  });
  it('не отдаёт webhook_secret и ключ в аккаунте', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        json(
          url.includes('/account')
            ? {
                balance_credits: 100,
                bonus_credits: 10,
                balance_total: 110,
                tier: 'basic',
                webhook_secret: 'private',
              }
            : { units: [unit] },
        ),
      ),
    );
    const result = await fixture().service.workspace();
    expect(JSON.stringify(result)).not.toMatch(/private|bsk_live/);
    expect(result.account.totalCredits).toBe(110);
  });
  it('не принимает подставленные op_key и локальный IP', async () => {
    const fetch = vi.fn().mockResolvedValue(json({ units: [unit] }));
    vi.stubGlobal('fetch', fetch);
    const { service } = fixture();
    await expect(service.preview({ ...input, ip: '127.0.0.1' })).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
    await expect(service.preview({ ...input, operators: ['guessed-operator'] })).rejects.toThrow();
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('предпросмотр не вызывает платный probe; потерянный ответ повторяется с тем же UUID', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    let probes = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        if (url.includes('/operators')) return json({ units: [unit] });
        if (url.endsWith('/probe/preview')) return json({ cost_credits: 25 });
        if (url.endsWith('/probe')) {
          if (++probes === 1) throw Error('lost');
          return json({
            outcome: 'done',
            cost_credits: 25,
            refunded: 0,
            by_target: {
              '8.8.8.8:443': {
                by_operator: {
                  [unit.op_key]: {
                    operator: 'test',
                    region: 'РФ',
                    dpi: 'on',
                    tcp: { ok: false },
                    icmp: { ok: true },
                    ok: true,
                    tcp_is_tls: true,
                  },
                },
              },
            },
            skipped_unavailable: [{ op_key: 'gone' }],
          });
        }
        throw Error(url);
      }),
    );
    const { service } = fixture();
    const preview = await service.preview(input);
    expect(probes).toBe(0);
    const first = await service.execute(preview.id);
    expect(first.status).toBe('uncertain');
    const second = await service.execute(preview.id);
    expect(second.status).toBe('done');
    expect(second.rows[0]?.tcp).toBe(false);
    expect(second.rows[0]?.icmp).toBe(true);
    expect(second.skippedCount).toBe(1);
    const runs = calls.filter((c) => c.url.endsWith('/probe'));
    expect(runs[0]?.init.body).toBe(runs[1]?.init.body);
    expect(runs.map((c) => (c.init.headers as Record<string, string>)['Idempotency-Key'])).toEqual([
      preview.id,
      preview.id,
    ]);
    await service.execute(preview.id);
    expect(probes).toBe(2);
  });
  it('не запускает проверку, если цена выросла после подтверждения', async () => {
    let prices = 0;
    const fetch = vi.fn(async (url: string) =>
      json(url.includes('/operators') ? { units: [unit] } : { cost_credits: ++prices === 1 ? 10 : 20 }),
    );
    vi.stubGlobal('fetch', fetch);
    const { service } = fixture();
    const p = await service.preview(input);
    await expect(service.execute(p.id)).rejects.toThrow('Стоимость изменилась');
    expect(fetch.mock.calls.some(([url]) => url.endsWith('/probe'))).toBe(false);
  });
  it('история сохраняет завершённые проверки, пропускает расчёты и чужое подключение без запросов к платному API', async () => {
    const { service, data } = fixture();
    const completed = {
      identity: 'credential-1',
      body: { target: '8.8.8.8:443', operators: ['one'] },
      cost: 19,
      expiresAt: '2026-10-12T00:10:00Z',
      run: {
        id: '4fab6a97-4d4e-42b7-a84d-6825b8375a72',
        status: 'done',
        costCredits: 19,
        refundedCredits: 0,
        error: null,
        rows: [],
      },
    };
    data.set('1', { key: 'bschecker.run.1', value: JSON.stringify(completed) });
    data.set('2', {
      key: 'bschecker.run.2',
      value: JSON.stringify({ ...completed, identity: 'another-key' }),
    });
    data.set('3', {
      key: 'bschecker.run.3',
      value: JSON.stringify({ ...completed, run: { ...completed.run, status: 'ready' } }),
    });
    data.set('bad', { key: 'bschecker.run.bad', value: 'invalid' });
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const result = await service.history();
    expect(result.runs).toHaveLength(1);
    expect(result.runs[0]).toMatchObject({
      target: '8.8.8.8:443',
      units: 1,
      estimatedCredits: 19,
      createdAt: '2026-10-12T00:00:00.000Z',
    });
    expect(JSON.stringify(result)).not.toContain('credential');
    expect(fetch).not.toHaveBeenCalled();
  });
});
