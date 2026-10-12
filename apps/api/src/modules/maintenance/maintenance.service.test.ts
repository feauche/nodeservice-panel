import { describe, expect, it, vi } from 'vitest';

import { MaintenanceService } from './maintenance.service.js';

describe('MaintenanceService retired startup work', () => {
  it('closes persisted running work without reconnecting to detached apt upgrades', async () => {
    const repo = {
      listRunning: vi.fn().mockResolvedValue([
        {
          id: 'detached-upgrade',
          serverId: 'legacy-server',
          kind: 'apt_upgrade',
          steps: [{ key: 'upgrade', status: 'running' }],
        },
        { id: 'old-check', serverId: 'legacy-server', kind: 'check', steps: [] },
      ]),
      failRun: vi.fn().mockResolvedValue(undefined),
    };
    const servers = { sshTargetFor: vi.fn() };
    const ssh = { connect: vi.fn() };
    const releases = { latest: vi.fn() };
    const notifications = { push: vi.fn() };
    const service = new MaintenanceService(
      repo as never,
      servers as never,
      {} as never,
      ssh as never,
      {} as never,
      releases as never,
      {} as never,
      {} as never,
      notifications as never,
    );

    await service.onModuleInit();
    service.onModuleDestroy();

    expect(repo.failRun).toHaveBeenCalledTimes(2);
    expect(repo.failRun).toHaveBeenCalledWith(
      'detached-upgrade',
      expect.stringContaining(
        'состояние ранее запущенной системной задачи на сервере нужно проверить вручную',
      ),
    );
    expect(repo.failRun).toHaveBeenCalledWith(
      'old-check',
      expect.stringContaining('без повторного выполнения'),
    );
    expect(servers.sshTargetFor).not.toHaveBeenCalled();
    expect(ssh.connect).not.toHaveBeenCalled();
    expect(releases.latest).not.toHaveBeenCalled();
    expect(notifications.push).not.toHaveBeenCalled();
  });
});
