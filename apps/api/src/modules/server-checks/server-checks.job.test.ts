import { describe, expect, it, vi } from 'vitest';

import { ServerChecksJob } from './server-checks.job.js';

describe('ServerChecksJob', () => {
  it('saves one fleet report with comparison to the previous run', async () => {
    const servers = {
      list: vi.fn().mockResolvedValue([
        { id: 's1', name: 'A', sshOk: true },
        { id: 's2', name: 'B', sshOk: false },
      ]),
    };
    const checks = {
      dueLightChecks: vi.fn().mockResolvedValue([{ serverId: 's1', check: 'cpu' }]),
      history: vi.fn().mockResolvedValue([{ status: 'failed' }]),
      scheduled: vi.fn().mockResolvedValue({ status: 'ok' }),
    };
    const autochecks = { get: vi.fn().mockResolvedValue({ serverChecksEnabled: true }) };
    const notifications = { push: vi.fn().mockResolvedValue(undefined) };
    const job = new ServerChecksJob(
      servers as never,
      checks as never,
      autochecks as never,
      notifications as never,
    );

    await job.run();

    expect(notifications.push).toHaveBeenCalledWith(
      expect.objectContaining({
        center: true,
        severity: 'ok',
        body: expect.stringContaining('лучше — 1, хуже — 0'),
      }),
    );
    const report = notifications.push.mock.calls[0]?.[0]?.body as string;
    expect(report).toContain('• A · процессор: успешно · исправилось');
    expect(report).toContain('• B: пропущено — SSH недоступен');
  });

  it('выделяет точную точку, где доступность из России ухудшилась', async () => {
    const block = (verdict: 'ok' | 'unreachable') => ({
      nodeName: 'A',
      address: '1.2.3.4',
      sniUsed: null,
      probes: [{ from: 'Россия - 1', verdict, detail: '', stalledAtKb: null, error: null }],
      foreign: [],
      verdict,
      unchecked: null,
      foreignUnchecked: null,
      entry: null,
    });
    const notifications = { push: vi.fn().mockResolvedValue(undefined) };
    const job = new ServerChecksJob(
      { list: vi.fn().mockResolvedValue([{ id: 's1', name: 'A', sshOk: true }]) } as never,
      {
        dueLightChecks: vi.fn().mockResolvedValue([{ serverId: 's1', check: 'russia_access' }]),
        history: vi.fn().mockResolvedValue([{ status: 'ok', blockResult: block('ok') }]),
        scheduled: vi.fn().mockResolvedValue({
          status: 'ok',
          check: 'russia_access',
          blockResult: block('unreachable'),
        }),
      } as never,
      { get: vi.fn().mockResolvedValue({ serverChecksEnabled: true }) } as never,
      notifications as never,
    );

    await job.run();

    expect(notifications.push).toHaveBeenCalledWith(expect.objectContaining({ severity: 'warn' }));
    const report = notifications.push.mock.calls[0]?.[0]?.body as string;
    expect(report).toContain('лучше — 0, хуже — 1');
    expect(report).toContain('Россия - 1: доступна → не отвечает');
  });

  it('marks a failed check as attention required', async () => {
    const notifications = { push: vi.fn().mockResolvedValue(undefined) };
    const job = new ServerChecksJob(
      { list: vi.fn().mockResolvedValue([{ id: 's1', name: 'A', sshOk: true }]) } as never,
      {
        dueLightChecks: vi.fn().mockResolvedValue([{ serverId: 's1', check: 'cpu' }]),
        history: vi.fn().mockResolvedValue([{ status: 'ok' }]),
        scheduled: vi.fn().mockResolvedValue({ status: 'failed' }),
      } as never,
      { get: vi.fn().mockResolvedValue({ serverChecksEnabled: true }) } as never,
      notifications as never,
    );

    await job.run();

    expect(notifications.push).toHaveBeenCalledWith(
      expect.objectContaining({ severity: 'warn', title: 'Автопроверки завершены с ошибками' }),
    );
  });
});
