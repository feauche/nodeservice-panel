import { MONITORING_DEFAULTS } from '@nodeservice/shared';
import { describe, expect, it, vi } from 'vitest';
import { NodesController } from './nodes.controller.js';

describe('Nodes live status', () => {
  it('refreshes upstream data at the configured interval and shares concurrent reads', async () => {
    let resolve!: () => void;
    const gate = new Promise<void>((r) => {
      resolve = r;
    });
    const status = { connected: true, lastAttemptAt: new Date(Date.now() - 61000).toISOString(), nodes: [] };
    const remote = { status: vi.fn().mockResolvedValue(status), syncQuiet: vi.fn(() => gate) };
    const providers = { enrich: vi.fn(async (s: unknown) => s) };
    const controller = new NodesController(
      remote as never,
      {} as never,
      providers as never,
      {} as never,
      {} as never,
      { get: async () => MONITORING_DEFAULTS } as never,
      {} as never,
    );
    const first = controller.status(),
      second = controller.status();
    await Promise.resolve();
    await Promise.resolve();
    expect(remote.syncQuiet).toHaveBeenCalledTimes(1);
    resolve();
    await Promise.all([first, second]);
  });
  it('keeps providers on refresh and connect, not only on periodic GET', async () => {
    const remote = {
      refresh: vi.fn().mockResolvedValue({ nodes: [] }),
      connect: vi.fn().mockResolvedValue({ nodes: [] }),
    };
    const providers = { enrich: vi.fn().mockResolvedValue({ nodes: [{ providerName: 'Provider' }] }) };
    const controller = new NodesController(
      remote as never,
      {} as never,
      providers as never,
      {} as never,
      {} as never,
      { get: async () => MONITORING_DEFAULTS } as never,
      {} as never,
    );
    expect(await controller.refresh()).toEqual({ nodes: [{ providerName: 'Provider' }] });
    expect(await controller.connect({ domain: 'panel.example.com', apiKey: 'secret123' })).toEqual({
      nodes: [{ providerName: 'Provider' }],
    });
  });
});
