import { describe, expect, it, vi } from 'vitest';

import { MaintenanceCheckJob } from './maintenance-check.job.js';

const check = (installed = '0.7.0', latest = 'v0.8.0') => ({
  os: { id: 'ubuntu', version: '24.04', pretty: 'Ubuntu 24.04' },
  updates: { total: 0, security: 0 },
  rebootRequired: false,
  disk: { usedPct: 10, freeBytes: 100 },
  agent: { installed, latest },
  supported: true,
  warnings: [],
});

function setup(updateResults: Array<{ ok: boolean; error: string | null }>) {
  const servers = {
    list: vi.fn().mockResolvedValue([
      { id: 's1', name: 'A', sshOk: true },
      { id: 's2', name: 'B', sshOk: true },
      { id: 's3', name: 'C', sshOk: true },
    ]),
  };
  const repo = { listStates: vi.fn().mockResolvedValue([]) };
  const maintenance = {
    scheduledCheck: vi.fn().mockResolvedValue(check()),
    scheduledAgentUpdate: vi.fn(),
  };
  for (const result of updateResults) maintenance.scheduledAgentUpdate.mockResolvedValueOnce(result);
  const notifications = { push: vi.fn().mockResolvedValue(undefined) };
  const job = new MaintenanceCheckJob(
    servers as never,
    repo as never,
    maintenance as never,
    notifications as never,
  );
  return { job, maintenance, notifications };
}

describe('MaintenanceCheckJob', () => {
  it('checks the fleet, then updates outdated agents one at a time', async () => {
    const { job, maintenance, notifications } = setup([
      { ok: true, error: null },
      { ok: true, error: null },
      { ok: true, error: null },
    ]);

    await job.run();

    expect(maintenance.scheduledCheck).toHaveBeenCalledTimes(3);
    expect(maintenance.scheduledAgentUpdate.mock.calls.map(([id]) => id)).toEqual(['s1', 's2', 's3']);
    expect(notifications.push).toHaveBeenCalledWith(
      expect.objectContaining({ center: true, severity: 'ok', title: 'Суточное обслуживание завершено' }),
    );
  });

  it('stops the update wave after the first failed server', async () => {
    const { job, maintenance, notifications } = setup([{ ok: false, error: 'heartbeat не пришёл' }]);

    await job.run();

    expect(maintenance.scheduledCheck).toHaveBeenCalledTimes(3);
    expect(maintenance.scheduledAgentUpdate).toHaveBeenCalledTimes(1);
    expect(notifications.push).toHaveBeenCalledWith(
      expect.objectContaining({
        severity: 'warn',
        body: expect.stringContaining('Серия остановлена на «A»'),
      }),
    );
  });

  it('does not reinstall an equal or newer agent', async () => {
    const { job, maintenance } = setup([]);
    maintenance.scheduledCheck
      .mockResolvedValueOnce(check('v0.8.0', '0.8.0'))
      .mockResolvedValueOnce(check('0.9.0', '0.8.0'))
      .mockResolvedValueOnce(null);

    await job.run();

    expect(maintenance.scheduledAgentUpdate).not.toHaveBeenCalled();
  });
});
