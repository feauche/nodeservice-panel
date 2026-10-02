import { describe, expect, it, vi } from 'vitest';

import { MaintenanceCheckJob } from './maintenance-check.job.js';

const check = (installed: string | null = '0.7.0', latest = 'v0.8.0') => ({
  os: { id: 'ubuntu', version: '24.04', pretty: 'Ubuntu 24.04' },
  updates: { total: 0, security: 0 },
  rebootRequired: false,
  disk: { usedPct: 10, freeBytes: 100 },
  agent: { installed, latest, service: installed ? 'active' : 'missing' },
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
  const repo = {
    listStates: vi.fn().mockResolvedValue([]),
    lastDailySweepAt: vi.fn().mockResolvedValue(null),
    completeDailySweep: vi.fn().mockResolvedValue(undefined),
    saveCheckError: vi.fn().mockResolvedValue(undefined),
  };
  const maintenance = {
    scheduledCheck: vi.fn().mockResolvedValue(check()),
    scheduledAgentUpdate: vi.fn().mockResolvedValue({ ok: true, error: null }),
  };
  for (const result of updateResults) maintenance.scheduledAgentUpdate.mockResolvedValueOnce(result);
  const notifications = { push: vi.fn().mockResolvedValue(undefined) };
  const job = new MaintenanceCheckJob(
    servers as never,
    repo as never,
    maintenance as never,
    notifications as never,
  );
  return { job, servers, repo, maintenance, notifications };
}

describe('MaintenanceCheckJob', () => {
  it('checks the fleet, then updates outdated agents one at a time', async () => {
    const { job, repo, maintenance, notifications } = setup([
      { ok: true, error: null },
      { ok: true, error: null },
      { ok: true, error: null },
    ]);

    await job.run();

    expect(maintenance.scheduledCheck).toHaveBeenCalledTimes(3);
    expect(repo.completeDailySweep).toHaveBeenCalledTimes(1);
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

  it('installs an agent that is missing from the server', async () => {
    const { job, maintenance, notifications } = setup([]);
    maintenance.scheduledCheck
      .mockResolvedValueOnce(check(null, 'v0.8.2'))
      .mockResolvedValueOnce(check('v0.8.2', 'v0.8.2'))
      .mockResolvedValueOnce(check('v0.8.2', 'v0.8.2'));

    await job.run();

    expect(maintenance.scheduledAgentUpdate).toHaveBeenCalledWith('s1', 'v0.8.2');
    expect(notifications.push).toHaveBeenCalledWith(
      expect.objectContaining({ body: expect.stringContaining('Агент установлен или обновлён: 1 из 1') }),
    );
  });

  it('repairs an installed agent whose service is stopped', async () => {
    const { job, maintenance } = setup([]);
    maintenance.scheduledCheck
      .mockResolvedValueOnce({
        ...check('v0.8.2', 'v0.8.2'),
        agent: { installed: 'v0.8.2', latest: 'v0.8.2', service: 'inactive' },
      })
      .mockResolvedValueOnce(check('v0.8.2', 'v0.8.2'))
      .mockResolvedValueOnce(check('v0.8.2', 'v0.8.2'));

    await job.run();

    expect(maintenance.scheduledAgentUpdate).toHaveBeenCalledWith('s1', 'v0.8.2');
  });

  it('a failed installation does not prevent installation on the rest of the fleet', async () => {
    const { job, repo, maintenance, notifications } = setup([
      { ok: false, error: 'SSH недоступен' },
      { ok: true, error: null },
      { ok: true, error: null },
    ]);
    maintenance.scheduledCheck.mockResolvedValue(check(null, 'v0.8.2'));

    await job.run();

    expect(maintenance.scheduledAgentUpdate).toHaveBeenCalledTimes(3);
    expect(repo.saveCheckError).toHaveBeenCalledWith('s1', 'Автоустановка агента не удалась: SSH недоступен');
    expect(notifications.push).toHaveBeenCalledWith(
      expect.objectContaining({
        severity: 'warn',
        body: expect.stringContaining('Не удалось установить или восстановить: 1 («A»)'),
      }),
    );
  });

  it('runs one daily sweep for the whole fleet, including a server with stale SSH status', async () => {
    const { job, servers, repo, maintenance } = setup([]);
    servers.list.mockResolvedValue([
      { id: 's1', name: 'A', sshOk: true },
      { id: 's2', name: 'B', sshOk: false },
    ]);

    await job.run();

    expect(maintenance.scheduledCheck.mock.calls.map(([id]) => id).sort()).toEqual(['s1', 's2']);
    expect(repo.completeDailySweep).toHaveBeenCalledTimes(1);
  });

  it('does not split a fresh daily sweep by individual server timestamps', async () => {
    const { job, repo, maintenance, notifications } = setup([]);
    repo.lastDailySweepAt.mockResolvedValue(new Date());
    repo.listStates.mockResolvedValue([
      {
        serverId: 's1',
        check: check(),
        checkError: null,
        updatedAt: new Date(Date.now() - 19 * 3_600_000),
      },
      {
        serverId: 's2',
        check: check(),
        checkError: null,
        updatedAt: new Date(),
      },
      {
        serverId: 's3',
        check: check(),
        checkError: null,
        updatedAt: new Date(),
      },
    ]);

    await job.run();

    expect(maintenance.scheduledCheck).not.toHaveBeenCalled();
    expect(notifications.push).not.toHaveBeenCalled();
  });

  it('retries a failed server after an hour without rerunning the whole fleet', async () => {
    const { job, repo, maintenance } = setup([]);
    repo.lastDailySweepAt.mockResolvedValue(new Date());
    repo.listStates.mockResolvedValue([
      {
        serverId: 's1',
        check: check(),
        checkError: 'SSH недоступен',
        updatedAt: new Date(Date.now() - 61 * 60_000),
      },
      {
        serverId: 's2',
        check: check(),
        checkError: null,
        updatedAt: new Date(),
      },
      {
        serverId: 's3',
        check: check(),
        checkError: null,
        updatedAt: new Date(),
      },
    ]);

    await job.run();

    expect(maintenance.scheduledCheck).toHaveBeenCalledTimes(1);
    expect(maintenance.scheduledCheck).toHaveBeenCalledWith('s1');
    expect(repo.completeDailySweep).not.toHaveBeenCalled();
  });

  it('records a deferred server and retries it later instead of losing it', async () => {
    const { job, repo, maintenance } = setup([]);
    maintenance.scheduledCheck.mockResolvedValueOnce(undefined);

    await job.run();

    expect(repo.saveCheckError).toHaveBeenCalledWith(
      's1',
      'Плановая проверка отложена: на сервере уже выполняется обслуживание.',
    );
  });
});
