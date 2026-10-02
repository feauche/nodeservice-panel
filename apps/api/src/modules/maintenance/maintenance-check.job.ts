import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import {
  compareVersions,
  MAINTENANCE_CHECK_INTERVAL_HOURS,
  type MaintenanceCheck,
} from '@nodeservice/shared';

import { NotificationsService } from '../notifications/notifications.service.js';
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
    private readonly notifications: NotificationsService,
  ) {}

  @Interval(5 * 60_000)
  async tick(): Promise<void> {
    // В e2e джобы не тикают сами — тесты управляют состоянием напрямую (детерминизм).
    if (process.env.NODE_ENV === 'test') return;
    await this.run();
  }

  async run(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const states = new Map((await this.repo.listStates()).map((s) => [s.serverId, s]));
      const deadline = Date.now() - MAINTENANCE_CHECK_INTERVAL_HOURS * 3_600_000;
      const outdated: Array<{ id: string; name: string; from: string; to: string }> = [];
      let checked = 0;
      let checkFailed = 0;
      for (const row of await this.servers.list()) {
        if (row.sshOk === false) continue;
        const st = states.get(row.id);
        if (st?.checkedAt && st.checkedAt.getTime() > deadline) continue;
        const check: MaintenanceCheck | null | undefined = await this.maintenance
          .scheduledCheck(row.id)
          .catch((err) => {
            this.log.warn(`Проверка обслуживания ${row.name}: ${(err as Error).message}`);
            return null;
          });
        if (check === undefined) continue;
        checked += 1;
        if (!check) {
          checkFailed += 1;
          continue;
        }
        if (
          check.agent.installed &&
          check.agent.latest &&
          compareVersions(check.agent.installed, check.agent.latest) < 0
        )
          outdated.push({ id: row.id, name: row.name, from: check.agent.installed, to: check.agent.latest });
      }

      let updated = 0;
      let stopped: { name: string; error: string } | null = null;
      // Проверяем весь парк до начала обновлений: если один сервер не обновился, остальные устаревшие
      // не попадут в следующую пятиминутку и серия действительно остановится до следующего суточного цикла.
      for (const row of outdated) {
        const result = await this.maintenance.scheduledAgentUpdate(row.id, row.to).catch((err) => ({
          ok: false,
          error: (err as Error).message,
        }));
        if (!result.ok) {
          stopped = { name: row.name, error: result.error ?? 'неизвестная ошибка' };
          this.log.warn(`Автообновление агента ${row.name}: ${stopped.error}`);
          break;
        }
        updated += 1;
      }

      if (checked > 0)
        await this.notifications.push({
          center: true,
          severity: stopped || checkFailed > 0 ? 'warn' : 'ok',
          title: stopped ? 'Суточное обслуживание требует внимания' : 'Суточное обслуживание завершено',
          body: [
            `Проверено серверов: ${checked}`,
            outdated.length > 0
              ? `Агент обновлён: ${updated} из ${outdated.length}`
              : 'Версии агентов актуальны',
            checkFailed > 0 ? `Не удалось проверить: ${checkFailed}` : null,
            stopped ? `Серия остановлена на «${stopped.name}»: ${stopped.error}` : null,
          ]
            .filter(Boolean)
            .join('\n'),
          link: { to: '/servers', label: 'Открыть серверы' },
          ...(stopped || checkFailed > 0 ? { telegram: { event: 'maintenance' as const } } : {}),
        });
    } finally {
      this.busy = false;
    }
  }
}
