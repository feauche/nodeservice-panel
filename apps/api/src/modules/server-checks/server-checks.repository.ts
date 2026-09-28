import { Inject, Injectable } from '@nestjs/common';
import type { ServerCheckKey, ServerCheckRun } from '@nodeservice/shared';
import { and, desc, eq, sql } from 'drizzle-orm';

import { DB, type Db } from '../../infra/db/db.module.js';
import { type ServerCheckRow, serverChecks } from '../../infra/db/schema/index.js';

export function toCheckRun(r: ServerCheckRow): ServerCheckRun {
  return {
    id: r.id,
    serverId: r.serverId,
    check: r.check,
    status: r.status,
    trigger: r.trigger,
    actorDisplay: r.actorDisplay,
    startedAt: r.startedAt.toISOString(),
    finishedAt: r.finishedAt ? r.finishedAt.toISOString() : null,
    output: r.output,
    error: r.error,
    explanation: r.explanation,
  };
}

/** Хранилище реестра проверок: запуски с выводом. Старые запуски одной проверки сверх последних 10 удаляются. */
@Injectable()
export class ServerChecksRepository {
  constructor(@Inject(DB) private readonly db: Db) {}

  async start(input: {
    serverId: string;
    check: ServerCheckKey;
    trigger: 'auto' | 'manual';
    actorDisplay: string | null;
  }): Promise<ServerCheckRow> {
    const [row] = await this.db.insert(serverChecks).values(input).returning();
    if (!row) throw new Error('Запуск проверки не записался');
    return row;
  }

  async setOutput(id: string, output: string): Promise<void> {
    await this.db.update(serverChecks).set({ output }).where(eq(serverChecks.id, id));
  }

  async finish(id: string, status: 'ok' | 'failed', output: string, error: string | null): Promise<void> {
    await this.db
      .update(serverChecks)
      .set({ status, output, error, finishedAt: new Date() })
      .where(eq(serverChecks.id, id));
  }

  async findById(id: string): Promise<ServerCheckRow | undefined> {
    const [row] = await this.db.select().from(serverChecks).where(eq(serverChecks.id, id)).limit(1);
    return row;
  }

  async setExplanation(id: string, explanation: string): Promise<void> {
    await this.db.update(serverChecks).set({ explanation }).where(eq(serverChecks.id, id));
  }

  /** Запуски одной проверки сервера, новые первыми. */
  async history(serverId: string, check: ServerCheckKey, limit = 10): Promise<ServerCheckRow[]> {
    return this.db
      .select()
      .from(serverChecks)
      .where(and(eq(serverChecks.serverId, serverId), eq(serverChecks.check, check)))
      .orderBy(desc(serverChecks.startedAt))
      .limit(limit);
  }

  async findRunning(serverId: string): Promise<ServerCheckRow | undefined> {
    const [row] = await this.db
      .select()
      .from(serverChecks)
      .where(and(eq(serverChecks.serverId, serverId), eq(serverChecks.status, 'running')))
      .limit(1);
    return row;
  }

  /** Последний запуск каждой проверки сервера. */
  async latest(serverId: string): Promise<ServerCheckRow[]> {
    return this.db
      .selectDistinctOn([serverChecks.check])
      .from(serverChecks)
      .where(eq(serverChecks.serverId, serverId))
      .orderBy(serverChecks.check, desc(serverChecks.startedAt));
  }

  /** Время последнего запуска каждой (сервер, проверка) — для суточного расписания. */
  /** Последний запуск каждой (сервер, проверка): когда и чем кончился — для суточного расписания. */
  async lastStarts(): Promise<
    Array<{ serverId: string; check: ServerCheckKey; at: Date; status: ServerCheckRow['status'] }>
  > {
    return this.db
      .selectDistinctOn([serverChecks.serverId, serverChecks.check], {
        serverId: serverChecks.serverId,
        check: serverChecks.check,
        at: serverChecks.startedAt,
        status: serverChecks.status,
      })
      .from(serverChecks)
      .orderBy(serverChecks.serverId, serverChecks.check, desc(serverChecks.startedAt));
  }

  /** Держим по 10 последних запусков каждой проверки сервера — историю для сравнения, без разрастания. */
  async prune(serverId: string, check: ServerCheckKey, keep = 10): Promise<void> {
    await this.db.execute(sql`
      delete from server_checks
      where server_id = ${serverId} and "check" = ${check} and status <> 'running'
        and id not in (
          select id from server_checks
          where server_id = ${serverId} and "check" = ${check}
          order by started_at desc
          limit ${keep}
        )`);
  }

  /** После перезапуска панели «идущие» запуски уже никто не доведёт. */
  async failOrphans(error: string): Promise<number> {
    const rows = await this.db
      .update(serverChecks)
      .set({ status: 'failed', error, finishedAt: new Date() })
      .where(eq(serverChecks.status, 'running'))
      .returning({ id: serverChecks.id });
    return rows.length;
  }
}
