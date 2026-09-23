import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { sql } from 'drizzle-orm';

import type { Env } from '../../config/env.schema.js';
import { DB, type Db } from '../../infra/db/db.module.js';
import { SYSTEM_ACTOR } from './audit.context.js';
import { AuditEvents } from './audit.events.js';
import { AuditRepository } from './audit.repository.js';
import { auditLog } from './audit.table.js';

/** На сколько месяцев вперёд держим готовые разделы (текущий + N). */
const PREMAKE_MONTHS = 2;
const PARTITION_RE = /^audit_log_y(\d{4})m(\d{2})$/;

/**
 * Разделы audit_log по месяцам: создание вперёд и удаление старых (retention) —
 * то, что в больших инсталляциях делает pg_partman. Здесь — сам сервис, раз в сутки и при старте.
 * Пишет системные события в Журнал напрямую (без AuditService — чтобы не было цикла зависимостей).
 */
@Injectable()
export class AuditPartitionsService implements OnApplicationBootstrap {
  private readonly log = new Logger(AuditPartitionsService.name);

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly config: ConfigService<Env, true>,
    private readonly events: AuditEvents,
    private readonly repo: AuditRepository,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    try {
      await this.ensureAhead();
    } catch (err) {
      // Не роняем старт: без раздела запись сама создаст его при первой вставке (AuditService).
      this.log.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'Не удалось подготовить разделы Журнала',
      );
    }
  }

  /** Ежедневно 03:17 — создать разделы вперёд и удалить старше срока хранения. */
  @Cron('17 3 * * *', { name: 'audit-partitions', timeZone: 'UTC' })
  async daily(): Promise<void> {
    try {
      await this.ensureAhead();
      await this.applyRetention();
    } catch (err) {
      this.log.error(
        { err: err instanceof Error ? err.message : String(err) },
        'Обслуживание разделов Журнала не удалось',
      );
    }
  }

  /** Разделы на текущий месяц и PREMAKE_MONTHS вперёд. */
  async ensureAhead(now = new Date()): Promise<string[]> {
    const created: string[] = [];
    for (let i = 0; i <= PREMAKE_MONTHS; i++) {
      const name = await this.ensureFor(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + i, 1)));
      if (name) created.push(name);
    }
    return created;
  }

  /** Раздел для месяца, в который попадает дата. Возвращает имя, если создан сейчас. */
  async ensureFor(date: Date): Promise<string | null> {
    const monthStart = `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-01`;
    const res = await this.db.execute<{ name: string | null }>(
      sql`select audit_log_ensure_partition(${monthStart}::date) as name`,
    );
    const name = res.rows[0]?.name ?? null;
    if (name) {
      this.log.log(`Журнал: создан раздел ${name}`);
      await this.systemEvent('system.audit.partition_created', name, { month: monthStart.slice(0, 7) });
    }
    return name;
  }

  /** Удалить разделы старше AUDIT_RETENTION_MONTHS (целиком, DROP — мгновенно и без bloat). */
  async applyRetention(now = new Date()): Promise<string[]> {
    const keepMonths = this.config.get('AUDIT_RETENTION_MONTHS');
    const threshold = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - keepMonths, 1));
    const dropped: string[] = [];
    for (const { name, month } of await this.listPartitions()) {
      if (month >= threshold) continue;
      await this.db.execute(sql.raw(`DROP TABLE IF EXISTS "${name}"`));
      dropped.push(name);
      this.log.warn(`Журнал: удалён раздел ${name} (старше ${keepMonths} мес.)`);
      await this.systemEvent('system.audit.partition_dropped', name, { retentionMonths: keepMonths });
    }
    return dropped;
  }

  async listPartitions(): Promise<Array<{ name: string; month: Date }>> {
    const res = await this.db.execute<{ name: string }>(
      sql`select c.relname as name from pg_inherits i join pg_class c on c.oid = i.inhrelid
          where i.inhparent = 'audit_log'::regclass order by c.relname`,
    );
    const out: Array<{ name: string; month: Date }> = [];
    for (const { name } of res.rows) {
      const m = PARTITION_RE.exec(name);
      if (!m) continue;
      out.push({ name, month: new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, 1)) });
    }
    return out;
  }

  private async systemEvent(
    action: string,
    partition: string,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    try {
      const [row] = await this.db
        .insert(auditLog)
        .values({
          actorType: SYSTEM_ACTOR.type,
          actorId: null,
          actorDisplay: SYSTEM_ACTOR.display,
          action,
          category: 'system',
          targetType: 'audit_partition',
          targetId: partition,
          targetDisplay: partition,
          result: 'ok',
          severity: 'info',
          source: 'auto',
          metadata,
        })
        .returning();
      if (row) this.events.emitCreated(this.repo.toEntry(row));
    } catch (err) {
      this.log.warn({ err: err instanceof Error ? err.message : String(err) }, `Не записал ${action}`);
    }
  }
}
