import { Inject, Injectable } from '@nestjs/common';
import {
  MAINTENANCE_LOG_MAX,
  type MaintenanceCheck,
  type MaintenanceKind,
  type MaintenanceRun,
  type MaintenanceStep,
} from '@nodeservice/shared';
import { and, desc, eq, sql } from 'drizzle-orm';

import { DB, type Db } from '../../infra/db/db.module.js';
import {
  type MaintenanceRunRow,
  type MaintenanceStateRow,
  maintenanceRuns,
  maintenanceState,
} from '../../infra/db/schema/index.js';

export function toRun(r: MaintenanceRunRow, withLog = true): MaintenanceRun {
  return {
    id: r.id,
    serverId: r.serverId,
    kind: r.kind,
    status: r.status,
    startedAt: r.startedAt.toISOString(),
    finishedAt: r.finishedAt ? r.finishedAt.toISOString() : null,
    actorDisplay: r.actorDisplay,
    steps: r.steps,
    log: withLog ? r.log : '',
    error: r.error,
  };
}

/** Хранилище обслуживания: состояние проверки на сервер и запуски с логом. */
@Injectable()
export class MaintenanceRepository {
  constructor(@Inject(DB) private readonly db: Db) {}

  async getState(serverId: string): Promise<MaintenanceStateRow | undefined> {
    return this.db.query.maintenanceState.findFirst({ where: eq(maintenanceState.serverId, serverId) });
  }

  async listStates(): Promise<MaintenanceStateRow[]> {
    return this.db.select().from(maintenanceState);
  }

  async saveCheck(serverId: string, check: MaintenanceCheck): Promise<void> {
    const now = new Date();
    await this.db
      .insert(maintenanceState)
      .values({ serverId, checkedAt: now, check, checkError: null, updatedAt: now })
      .onConflictDoUpdate({
        target: maintenanceState.serverId,
        set: { checkedAt: now, check, checkError: null, updatedAt: now },
      });
  }

  /** Проверка не удалась: прошлый результат остаётся, но помечаем ошибку и время попытки. */
  async saveCheckError(serverId: string, error: string): Promise<void> {
    const now = new Date();
    await this.db
      .insert(maintenanceState)
      .values({ serverId, checkedAt: now, check: null, checkError: error, updatedAt: now })
      .onConflictDoUpdate({
        target: maintenanceState.serverId,
        set: { checkedAt: now, checkError: error, updatedAt: now },
      });
  }

  async startRun(input: {
    serverId: string;
    kind: MaintenanceKind;
    actorId: string | null;
    actorDisplay: string | null;
    steps: MaintenanceStep[];
  }): Promise<MaintenanceRunRow> {
    const [row] = await this.db
      .insert(maintenanceRuns)
      .values({
        serverId: input.serverId,
        kind: input.kind,
        actorId: input.actorId,
        actorDisplay: input.actorDisplay,
        steps: input.steps,
      })
      .returning();
    if (!row) throw new Error('Не удалось создать запуск обслуживания');
    return row;
  }

  async setSteps(id: string, steps: MaintenanceStep[]): Promise<void> {
    await this.db.update(maintenanceRuns).set({ steps }).where(eq(maintenanceRuns.id, id));
  }

  /** Дописать лог; выше MAINTENANCE_LOG_MAX — хвост отбрасывается с пометкой. */
  async appendLog(id: string, chunk: string): Promise<void> {
    await this.db.execute(sql`
      update "maintenance_runs"
      set "log" = case
        when length("log") >= ${MAINTENANCE_LOG_MAX} then "log"
        when length("log") + length(${chunk}) > ${MAINTENANCE_LOG_MAX}
          then substr("log" || ${chunk}, 1, ${MAINTENANCE_LOG_MAX}) || E'\n… (лог усечён)\n'
        else "log" || ${chunk}
      end
      where "id" = ${id}
    `);
  }

  async finishRun(
    id: string,
    status: 'ok' | 'failed',
    steps: MaintenanceStep[],
    error: string | null,
  ): Promise<void> {
    await this.db
      .update(maintenanceRuns)
      .set({ status, steps, error, finishedAt: new Date() })
      .where(eq(maintenanceRuns.id, id));
  }

  async getRun(id: string): Promise<MaintenanceRunRow | undefined> {
    return this.db.query.maintenanceRuns.findFirst({ where: eq(maintenanceRuns.id, id) });
  }

  async findRunning(serverId: string): Promise<MaintenanceRunRow | undefined> {
    return this.db.query.maintenanceRuns.findFirst({
      where: and(eq(maintenanceRuns.serverId, serverId), eq(maintenanceRuns.status, 'running')),
      orderBy: desc(maintenanceRuns.startedAt),
    });
  }

  async lastFinished(serverId: string): Promise<MaintenanceRunRow | undefined> {
    return this.db.query.maintenanceRuns.findFirst({
      where: and(eq(maintenanceRuns.serverId, serverId), sql`${maintenanceRuns.status} <> 'running'`),
      orderBy: desc(maintenanceRuns.startedAt),
    });
  }

  async listRuns(serverId: string, limit: number): Promise<MaintenanceRunRow[]> {
    return this.db
      .select()
      .from(maintenanceRuns)
      .where(eq(maintenanceRuns.serverId, serverId))
      .orderBy(desc(maintenanceRuns.startedAt))
      .limit(limit);
  }

  /** После рестарта панели «идущие» запуски не доживают — закрываем их с понятной причиной. */
  async failOrphans(reason: string): Promise<number> {
    const rows = await this.db
      .update(maintenanceRuns)
      .set({ status: 'failed', error: reason, finishedAt: new Date() })
      .where(eq(maintenanceRuns.status, 'running'))
      .returning({ id: maintenanceRuns.id });
    return rows.length;
  }
}
