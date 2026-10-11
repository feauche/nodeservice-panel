import { afterEach, describe, expect, it, vi } from 'vitest';
import { NodeActionsController } from './node-actions.controller.js';

const uuid = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const providerUuid = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
afterEach(() => vi.unstubAllGlobals());
function setup() {
  const permissions = { check: vi.fn(), observe: vi.fn((_scope, _creds, fn) => fn()) };
  const providers = { list: vi.fn(async () => [{ uuid: providerUuid }]), invalidate: vi.fn() };
  const remna = { syncQuiet: vi.fn() };
  const controller = new NodeActionsController(
    permissions as never,
    { credentials: async () => ({ domain: 'panel.example', apiKey: 'test-key' }) } as never,
    providers as never,
    remna as never,
  );
  return { controller, permissions, providers, remna };
}
describe('node actions', () => {
  it('normalizes preview authority and rejects malformed domains before any request', () => {
    const { controller, permissions } = setup();
    controller.permissionsPreview({ domain: 'EXAMPLE.COM:443', apiKey: 'test' });
    expect(permissions.check).toHaveBeenCalledWith({ domain: 'example.com', apiKey: 'test' });
    for (const domain of [
      'bad host',
      'user@example.com',
      'example.com/path',
      'example.com?q=1',
      'example.com#x',
    ])
      expect(() => controller.permissionsPreview({ domain, apiKey: 'test' })).toThrow();
    expect(permissions.check).toHaveBeenCalledTimes(1);
  });
  it('reassigns only this node UUID and provider UUID without editing provider identity', async () => {
    const { controller, permissions, remna } = setup();
    const fetcher = vi.fn(async () => new Response('{}'));
    vi.stubGlobal('fetch', fetcher);
    await controller.assign(uuid, { providerUuid });
    expect(permissions.observe.mock.calls[0][0]).toBe('nodes:update');
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://panel.example/api/nodes');
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(init.body as string)).toEqual({ uuid, providerUuid });
    expect(remna.syncQuiet).toHaveBeenCalledOnce();
  });
  it('reports missing write permission and does not publish a successful refresh', async () => {
    const { controller, remna } = setup();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('', { status: 403 })),
    );
    await expect(controller.assign(uuid, { providerUuid })).rejects.toThrow('nodes:update');
    expect(remna.syncQuiet).not.toHaveBeenCalled();
  });
});
