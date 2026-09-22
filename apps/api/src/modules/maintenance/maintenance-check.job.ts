import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { MAINTENANCE_CHECK_INTERVAL_HOURS } from '@nodeservice/shared';

import { ServersRepository } from '../servers/servers.repository.js';
import { MaintenanceRepository } from './maintenance.repository.js';
import { MaintenanceService } from './maintenance.service.js';

/**
 * Суточная проверка обслуживания: раз в 5 минут смотрим, у кого прошло больше суток с последней
 * проверки (или её не было), и проверяем по одному. Серверы с заведомо мёртвым SSH пропускаем —
 * их и так подсвечивает автопроверка связи.
 */
@Injectable()
export class MaintenanceCheckJob {
  private readonly log = new Logger(MaintenanceCheckJob.name);
  private busy = false;

  constructor(
    private readonly servers: ServersRepository,
    private readonly repo: MaintenanceRepository,
    private readonly maintenance: MaintenanceService,
  ) {}

  @Interval(5 * 60_000)
  async tick(): Promise<void> {
    // В e2e джобы не тикают сами — тесты управляют состоянием напрямую (детерминизм).
    if (process.env.NODE_ENV === 'test') return;
    if (this.busy) return;
    this.busy = true;
    try {
      const states = new Map((await this.repo.listStates()).map((s) => [s.serverId, s]));
      const deadline = Date.now() - MAINTENANCE_CHECK_INTERVAL_HOURS * 3_600_000;
      for (const row of await this.servers.list()) {
        if (row.sshOk === false) continue;
        const st = states.get(row.id);
        if (st?.checkedAt && st.checkedAt.getTime() > deadline) continue;
        await this.maintenance.scheduledCheck(row.id).catch((err) => {
          this.log.warn(`Проверка обслуживания ${row.name}: ${(err as Error).message}`);
        });
      }
    } finally {
      this.busy = false;
    }
  }
}
