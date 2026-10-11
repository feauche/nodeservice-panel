import { ForbiddenException } from '@nestjs/common';
import { remnaProviderUpdateSchema } from '@nodeservice/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseProviders, RemnaProvidersService, safeProviderUrl } from './remna-providers.service.js';

const uuid = '0cc5a547-c445-4b59-b50d-6b7224513049';
const nodeUuid = 'acff8511-c1a5-497c-bbab-1355b61d8386';
const provider = { uuid, name: '4vps', loginUrl: 'https://4vps.su/account', faviconLink: 'https://4vps.su' };
const node = { uuid: nodeUuid, name: 'Turkey', countryCode: 'TR', providerUuid: uuid };
const credentials = { domain: 'panel.example.com', apiKey: 'private-secret-key' };
const store = () => ({ credentials: vi.fn().mockResolvedValue(credentials) });
describe('Remnawave provider synchronisation', () => {
  afterEach(() => vi.unstubAllGlobals());
  it('joins the direct provider UUID even without billing/payment records', () => {
    const result = parseProviders({ response: { providers: [provider] } }, { response: [node] });
    expect(result[0]?.nodes).toEqual([{ uuid: nodeUuid, name: 'Turkey', countryCode: 'TR' }]);
    expect(result[0]?.faviconLink).toBe('https://4vps.su/');
  });
  it('rejects credential URLs and executable link schemes', () => {
    expect(safeProviderUrl('javascript:alert(1)')).toBeNull();
    expect(safeProviderUrl('https://user:pass@example.com')).toBeNull();
    expect(remnaProviderUpdateSchema.safeParse({ loginUrl: 'javascript:alert(1)' }).success).toBe(false);
    expect(remnaProviderUpdateSchema.safeParse({}).success).toBe(false);
    expect(remnaProviderUpdateSchema.parse({ name: 'New', faviconLink: 'https://evil.example' })).toEqual({
      name: 'New',
    });
  });
  it('patches only changed fields on the same UUID and refreshes the remote source', async () => {
    let remote = { ...provider };
    const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'PATCH') {
        const body = JSON.parse(String(init.body));
        expect(body).toEqual({ uuid, name: 'Renamed' });
        remote = { ...remote, ...body };
        return new Response(JSON.stringify({ response: remote }));
      }
      return new Response(
        JSON.stringify({ response: url.endsWith('/api/nodes') ? [node] : { providers: [remote] } }),
      );
    });
    vi.stubGlobal('fetch', fetcher);
    const service = new RemnaProvidersService(
      store() as never,
      { dto: vi.fn(async (p) => ({ id: p.uuid, hasIcon: false, iconVersion: 0 })) } as never,
    );
    expect((await service.list())[0]?.name).toBe('4vps');
    await service.update(uuid, { name: 'Renamed' });
    const result = await service.list();
    expect(result[0]).toMatchObject({
      name: 'Renamed',
      loginUrl: provider.loginUrl,
      faviconLink: 'https://4vps.su/',
    });
    expect(fetcher.mock.calls.every(([, init]) => init?.redirect === 'error')).toBe(true);
  });
  it('creates a provider remotely and accepts an empty 204 deletion response', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ response: provider })))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetcher);
    const service = new RemnaProvidersService(store() as never, {} as never);
    const input = { name: provider.name, loginUrl: provider.loginUrl, faviconLink: provider.faviconLink };
    expect(await service.create(input)).toMatchObject({ uuid, name: provider.name });
    expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual(input);
    expect(fetcher.mock.calls[0][1].method).toBe('POST');
    await expect(service.remove(uuid)).resolves.toBeUndefined();
    expect(fetcher.mock.calls[1][0]).toBe(`https://panel.example.com/api/infra-billing/providers/${uuid}`);
    expect(fetcher.mock.calls[1][1].method).toBe('DELETE');
  });
  it('derives the favicon source when the site changes, including clearing it', async () => {
    const fetcher = vi.fn().mockImplementation(async () => new Response('{}'));
    vi.stubGlobal('fetch', fetcher);
    const service = new RemnaProvidersService(store() as never, {} as never);
    for (const loginUrl of ['https://new.example', null]) {
      await service.update(uuid, { loginUrl });
      expect(JSON.parse(fetcher.mock.calls.at(-1)[1].body)).toEqual({
        uuid,
        loginUrl,
        faviconLink: loginUrl,
      });
    }
  });
  it('exposes missing permissions without leaking tokens or remote error bodies', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('private upstream text', { status: 403 })));
    const service = new RemnaProvidersService(
      store() as never,
      { dto: vi.fn(async (p) => ({ id: p.uuid, hasIcon: false, iconVersion: 0 })) } as never,
    );
    await expect(service.update(uuid, { name: 'Name' })).rejects.toBeInstanceOf(ForbiddenException);
    const status = await service.enrich({ connected: true, nodes: [node] } as never);
    expect(status.providerError).toContain('update-provider');
    expect(JSON.stringify(status)).not.toContain(credentials.apiKey);
    expect(JSON.stringify(status)).not.toContain('private upstream');
  });
  it('changes coming from Remnawave replace the cached provider on the next poll', async () => {
    const clock = vi.spyOn(Date, 'now');
    clock.mockReturnValue(1000);
    let name = 'Before';
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async (url: string) =>
          new Response(
            JSON.stringify({
              response: url.endsWith('/api/nodes') ? [node] : { providers: [{ ...provider, name }] },
            }),
          ),
      ),
    );
    try {
      const service = new RemnaProvidersService(
        store() as never,
        { dto: vi.fn(async (p) => ({ id: p.uuid, hasIcon: false, iconVersion: 0 })) } as never,
      );
      expect((await service.list())[0]?.name).toBe('Before');
      name = 'After';
      clock.mockReturnValue(16000);
      expect((await service.list())[0]?.name).toBe('After');
    } finally {
      clock.mockRestore();
    }
  });
});
