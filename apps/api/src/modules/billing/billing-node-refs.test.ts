import type { BillingItemUpsert } from '@nodeservice/shared';
import { describe, expect, it, vi } from 'vitest';
import { BillingService } from './billing.service.js';

const uuid = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
function setup() {
  const db = {
    query: {
      appMeta: {
        findFirst: async () => ({
          value: JSON.stringify({
            domain: 'panel.example',
            snapshot: { nodes: [{ uuid, name: 'Trusted name' }] },
          }),
        }),
      },
    },
    select: () => ({ from: async () => [] }),
  };
  return new BillingService(db as never, {} as never, {} as never, {} as never, {} as never);
}
const body = (panel = 'panel.example') =>
  ({
    nodeRefs: [{ panel, uuid, name: 'Untrusted name' }],
    serverIds: [],
    providerId: null,
  }) as unknown as BillingItemUpsert;
describe('billing node identity', () => {
  it('normalizes current node names and does not call remote services', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch');
    try {
      const service = setup();
      const value = body();
      // biome-ignore lint/complexity/useLiteralKeys: access private validation in boundary regression test
      await service['validate'](value);
      expect(value.nodeRefs?.[0].name).toBe('Trusted name');
      expect(fetcher).not.toHaveBeenCalled();
    } finally {
      fetcher.mockRestore();
    }
  });
  it('rejects same UUID on another panel for a new payment', async () => {
    // biome-ignore lint/complexity/useLiteralKeys: access private validation in boundary regression test
    await expect(setup()['validate'](body('other.example'))).rejects.toThrow();
  });
  it('preserves historical reference after changing panel or removing node', async () => {
    const value = body('old.example');
    // biome-ignore lint/complexity/useLiteralKeys: access private validation in boundary regression test
    await setup()['validate'](value, null, [{ panel: 'old.example', uuid, name: 'Historical name' }]);
    expect(value.nodeRefs?.[0].name).toBe('Historical name');
  });
});
