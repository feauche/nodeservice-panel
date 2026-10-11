import { describe, expect, it, vi } from 'vitest';
import { isPrivateHost } from '../providers/icon-fetch.service.js';
import { RemnaProviderAssetsService } from './remna-provider-assets.service.js';

const provider = {
  uuid: '0cc5a547-c445-4b59-b50d-6b7224513049',
  name: 'Provider',
  loginUrl: 'https://t.me/bot',
  faviconLink: 'https://icons.example/logo.ico',
  nodes: [],
};
function setup(icons: unknown) {
  let record: { key: string; value: string } | null = null;
  const db = {
    query: { appMeta: { findFirst: vi.fn(async () => record) } },
    insert: () => ({
      values: (row: { key: string; value: string }) => ({
        onConflictDoUpdate: async () => {
          record = row;
        },
      }),
    }),
  };
  return {
    service: new RemnaProviderAssetsService(
      db as never,
      { domain: async () => 'panel.example.com' } as never,
      icons as never,
    ),
    value: () => JSON.parse(record?.value ?? '{}'),
  };
}
describe('remote provider icon assets', () => {
  it('uses the Remna icon source before the login page, with existing icon discovery', async () => {
    const icons = {
      fetchDirect: vi.fn().mockResolvedValue({
        icon: { type: 'image/png', data: Buffer.from('png'), sourceUrl: provider.faviconLink },
        reason: null,
      }),
      fetch: vi.fn(),
    };
    const { service } = setup(icons);
    await service.refresh(provider);
    expect(icons.fetchDirect).toHaveBeenCalledWith(provider.faviconLink);
    expect(icons.fetch).not.toHaveBeenCalled();
    expect((await service.dto(provider)).hasIcon).toBe(true);
  });
  it('does not present the favicon address as a missing provider website', async () => {
    const { service } = setup({ fetchDirect: vi.fn().mockResolvedValue({ icon: null }) });
    expect(await service.dto({ ...provider, loginUrl: null })).toMatchObject({ siteUrl: '', siteHost: '' });
  });
  it('an old failed search cannot mark the new source as finished', async () => {
    let reject!: (error: Error) => void;
    const gate = new Promise<never>((_, r) => {
      reject = r;
    });
    const { service, value } = setup({ fetchDirect: vi.fn(() => gate) });
    const pending = service.refresh(provider);
    await vi.waitFor(() => expect(value().source).toContain(provider.faviconLink));
    await service.ensure({ ...provider, faviconLink: 'https://other.example/logo.ico' }, false);
    reject(new Error('old source failed'));
    await pending;
    expect(value().source).toContain('other.example');
    expect(value().checked).toBe(false);
  });
  it('blocks normalised and expanded IPv4-mapped IPv6 private addresses', () => {
    for (const value of [
      'http://[::ffff:127.0.0.1]/favicon.ico',
      'http://[::ffff:10.0.0.1]/favicon.ico',
      'http://[0:0:0:0:0:ffff:7f00:1]/',
    ])
      expect(isPrivateHost(new URL(value).hostname)).toBe(true);
  });
});
