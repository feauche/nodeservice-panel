import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { and, eq, isNotNull, lt } from 'drizzle-orm';

import type { Env } from '../../config/env.schema.js';
import { DB, type Db } from '../../infra/db/db.module.js';
import { incidents } from '../../infra/db/schema/incidents.js';
import { SYSTEM_ACTOR } from '../audit/audit.context.js';
import { AuditService } from '../audit/audit.service.js';

export interface RetentionReport {
  incidents: number;
}

/**
 * Ночная чистка по сроку хранения (env INCIDENTS_RETENTION_DAYS): решённые события. Открытые не трогаем.
 * Журнал чистится отдельно помесячно (AuditPartitionsService), замеры нод — при записи. Итог — записью в Журнал.
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
    const days = this.config.get('INCIDENTS_RETENTION_DAYS');
    const threshold = new Date(now.getTime() - days * 86_400_000);
    const inc = await this.db
      .delete(incidents)
      .where(
        and(
          eq(incidents.status, 'resolved'),
          isNotNull(incidents.resolvedAt),
          lt(incidents.resolvedAt, threshold),
        ),
      )
      .returning({ id: incidents.id });
    const report = { incidents: inc.length };
    if (report.incidents > 0) {
      this.log.log(`удалено по сроку хранения: события ${report.incidents}`);
      await this.audit.record({
        action: 'system.retention.applied',
        actor: SYSTEM_ACTOR,
        source: 'auto',
        metadata: { ...report, retentionDays: { incidents: days } },
      });
    }
    return report;
  }
}
