import { afterEach, describe, expect, it, vi } from 'vitest';
import { RemnaPermissionsService } from './remna-permissions.service.js';
import { RemnawaveApiError } from './remnawave-client.js';

const first = { domain: 'panel.example', apiKey: 'first-secret' },
  second = { domain: 'other.example', apiKey: 'second-secret' };
afterEach(() => vi.unstubAllGlobals());
describe('Remna permission evidence', () => {
  it('only issues GET probes and separates denied from network/unknown write access', async () => {
    const fetcher = vi.fn(async (url: string) => {
      if (url.endsWith('/nodes')) return new Response('', { status: 403 });
      if (url.endsWith('/metadata')) throw new Error('network');
      return new Response('{}');
    });
    vi.stubGlobal('fetch', fetcher);
    const service = new RemnaPermissionsService({ credentials: async () => first } as never);
    const result = (await service.check()) as { items: { scope: string; state: string }[] };
    expect(result.items.find((p) => p.scope === 'nodes:list')?.state).toBe('denied');
    expect(result.items.find((p) => p.scope === 'system:metadata')?.state).toBe('unknown');
    expect(result.items.find((p) => p.scope === 'system:stats')?.state).toBe('granted');
    expect(result.items.find((p) => p.scope === 'nodes:update')?.state).toBe('unknown');
    // Чтение Host проверяется само, изменение Host — только по делу (срабатывание сценария).
    expect(result.items.find((p) => p.scope === 'hosts:list')?.state).toBe('granted');
    expect(result.items.find((p) => p.scope === 'hosts:update')).toMatchObject({
      state: 'unknown',
      when: 'Проверится при срабатывании сценария',
    });
    expect(fetcher.mock.calls).toHaveLength(7);
    expect(
      fetcher.mock.calls.every(
        (c) => !(c as unknown[])[1] || (c as [string, RequestInit])[1].method === undefined,
      ),
    ).toBe(true);
  });
  it('records only the exact token used by a real action and expires evidence on token change', async () => {
    let creds = first;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{}')),
    );
    const service = new RemnaPermissionsService({ credentials: async () => creds } as never);
    await service.observe('nodes:update', first, async () => {
      creds = second;
      return true;
    });
    let result = (await service.check()) as { items: { scope: string; state: string }[] };
    expect(result.items.find((p) => p.scope === 'nodes:update')?.state).toBe('unknown');
    await expect(
      service.observe('nodes:update', second, async () => {
        throw new RemnawaveApiError('403', 'unauthorized');
      }),
    ).rejects.toThrow();
    result = (await service.check()) as typeof result;
    expect(result.items.find((p) => p.scope === 'nodes:update')?.state).toBe('denied');
    expect(JSON.stringify(result)).not.toContain('secret');
  });
});
