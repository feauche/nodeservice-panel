import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { and, eq, isNotNull, lt, ne } from 'drizzle-orm';

import type { Env } from '../../config/env.schema.js';
import { DB, type Db } from '../../infra/db/db.module.js';
import { incidents } from '../../infra/db/schema/incidents.js';
import { notifications } from '../../infra/db/schema/notifications.js';
import { maintenanceRuns, terminalSessions } from '../../infra/db/schema/servers.js';
import { SYSTEM_ACTOR } from '../audit/audit.context.js';
import { AuditService } from '../audit/audit.service.js';

export interface RetentionReport {
  terminalSessions: number;
  maintenanceRuns: number;
  incidents: number;
  notifications: number;
}

/**
 * Ночная чистка растущих таблиц по сроку хранения (env *_RETENTION_DAYS):
 * записи веб-терминала (transcript до 2 МБ каждая), запуски обслуживания с логами, решённые
 * инциденты. Живые сессии, незавершённые запуски и открытые инциденты не трогаем.
 * Журнал чистится отдельно помесячно (AuditPartitionsService). Итог — записью в Журнал.
 */
@Injectable()
export class HousekeepingService {
  private readonly log = new Logger(HousekeepingService.name);

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly config: ConfigService<Env, true>,
    private readonly audit: AuditService,
  ) {}

  /** 03:47 — после ночного бэкапа (03:17), чтобы в бэкап попало всё, что вот-вот удалим. */
  @Cron('47 3 * * *', { name: 'housekeeping-retention', timeZone: 'UTC' })
  async nightly(): Promise<void> {
    if (process.env.NODE_ENV === 'test') return;
    try {
      await this.applyRetention();
    } catch (err) {
      this.log.warn(`чистка по сроку хранения не удалась: ${(err as Error).message}`);
    }
  }

  async applyRetention(now = new Date()): Promise<RetentionReport> {
    const before = (days: number) => new Date(now.getTime() - days * 86_400_000);
    const tTerm = before(this.config.get('TERMINAL_RETENTION_DAYS'));
    const tMaint = before(this.config.get('MAINTENANCE_RETENTION_DAYS'));
    const tInc = before(this.config.get('INCIDENTS_RETENTION_DAYS'));
    const tNotif = before(this.config.get('NOTIFICATIONS_RETENTION_DAYS'));

    const term = await this.db
      .delete(terminalSessions)
      .where(and(isNotNull(terminalSessions.endedAt), lt(terminalSessions.endedAt, tTerm)))
      .returning({ id: terminalSessions.id });
    const maint = await this.db
      .delete(maintenanceRuns)
      .where(
        and(
          ne(maintenanceRuns.status, 'running'),
          isNotNull(maintenanceRuns.finishedAt),
          lt(maintenanceRuns.finishedAt, tMaint),
        ),
      )
      .returning({ id: maintenanceRuns.id });
    const inc = await this.db
      .delete(incidents)
      .where(
        and(
          eq(incidents.status, 'resolved'),
          isNotNull(incidents.resolvedAt),
          lt(incidents.resolvedAt, tInc),
        ),
      )
      .returning({ id: incidents.id });

    const notif = await this.db
      .delete(notifications)
      .where(lt(notifications.createdAt, tNotif))
      .returning({ id: notifications.id });

    const report = {
      terminalSessions: term.length,
      maintenanceRuns: maint.length,
      incidents: inc.length,
      notifications: notif.length,
    };
    const total = report.terminalSessions + report.maintenanceRuns + report.incidents + report.notifications;
    if (total > 0) {
      this.log.log(
        `удалено по сроку хранения: терминал ${report.terminalSessions}, обслуживание ${report.maintenanceRuns}, инциденты ${report.incidents}`,
      );
      await this.audit.record({
        action: 'system.retention.applied',
        actor: SYSTEM_ACTOR,
        source: 'auto',
        metadata: {
          ...report,
          retentionDays: {
            terminal: this.config.get('TERMINAL_RETENTION_DAYS'),
            maintenance: this.config.get('MAINTENANCE_RETENTION_DAYS'),
            incidents: this.config.get('INCIDENTS_RETENTION_DAYS'),
            notifications: this.config.get('NOTIFICATIONS_RETENTION_DAYS'),
          },
        },
      });
    }
    return report;
  }
}
