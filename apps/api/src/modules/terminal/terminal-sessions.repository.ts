import { Inject, Injectable } from '@nestjs/common';
import {
  TERMINAL_HISTORY_DAYS,
  TERMINAL_TRANSCRIPT_MAX,
  type TerminalSessionDetail,
  type TerminalSessionInfo,
} from '@nodeservice/shared';
import { and, desc, eq, lt, sql } from 'drizzle-orm';

import { DB, type Db } from '../../infra/db/db.module.js';
import { type TerminalSessionRow, terminalSessions } from '../../infra/db/schema/index.js';

function toInfo(r: TerminalSessionRow): TerminalSessionInfo {
  return {
    id: r.id,
    serverId: r.serverId,
    actorDisplay: r.actorDisplay,
    startedAt: r.startedAt.toISOString(),
    endedAt: r.endedAt ? r.endedAt.toISOString() : null,
    cols: r.cols,
    rows: r.rows,
    bytesOut: r.bytesOut,
    truncated: r.truncated,
    exitCode: r.exitCode,
    endReason: r.endReason,
  };
}

/** Хранилище истории терминала: одна строка на сессию, вывод дописывается порциями. */
@Injectable()
export class TerminalSessionsRepository {
  constructor(@Inject(DB) private readonly db: Db) {}

  async start(input: {
    serverId: string;
    actorId: string | null;
    actorDisplay: string | null;
    cols: number;
    rows: number;
  }): Promise<string> {
    const [row] = await this.db
      .insert(terminalSessions)
      .values({
        serverId: input.serverId,
        actorId: input.actorId,
        actorDisplay: input.actorDisplay,
        cols: input.cols,
        rows: input.rows,
      })
      .returning({ id: terminalSessions.id });
    if (!row) throw new Error('Не удалось начать запись сессии терминала');
    return row.id;
  }

  /**
   * Дописать порцию вывода. Запись растёт до TERMINAL_TRANSCRIPT_MAX символов, дальше
   * помечается усечённой, а счётчик байт продолжает расти — по нему видно реальный объём.
   */
  async append(id: string, chunk: string, bytes: number): Promise<void> {
    await this.db.execute(sql`
      update "terminal_sessions"
      set "bytes_out" = "bytes_out" + ${bytes},
          "truncated" = "truncated" or length("transcript") + length(${chunk}) > ${TERMINAL_TRANSCRIPT_MAX},
          "transcript" = case
            when length("transcript") + length(${chunk}) > ${TERMINAL_TRANSCRIPT_MAX} then "transcript"
            else "transcript" || ${chunk}
          end
      where "id" = ${id}
    `);
  }

  async finish(id: string, exitCode: number | null, endReason: string | null): Promise<void> {
    await this.db
      .update(terminalSessions)
      .set({ endedAt: new Date(), exitCode, endReason })
      .where(eq(terminalSessions.id, id));
  }

  async resize(id: string, cols: number, rows: number): Promise<void> {
    await this.db.update(terminalSessions).set({ cols, rows }).where(eq(terminalSessions.id, id));
  }

  async list(serverId: string, limit: number): Promise<TerminalSessionInfo[]> {
    const rows = await this.db
      .select()
      .from(terminalSessions)
      .where(eq(terminalSessions.serverId, serverId))
      .orderBy(desc(terminalSessions.startedAt))
      .limit(limit);
    return rows.map(toInfo);
  }

  /** Запись начиная с offset (в символах): живая сессия догружается дельтами. */
  async get(serverId: string, id: string, offset = 0): Promise<TerminalSessionDetail | null> {
    const [row] = await this.db
      .select({
        id: terminalSessions.id,
        serverId: terminalSessions.serverId,
        actorId: terminalSessions.actorId,
        actorDisplay: terminalSessions.actorDisplay,
        startedAt: terminalSessions.startedAt,
        endedAt: terminalSessions.endedAt,
        cols: terminalSessions.cols,
        rows: terminalSessions.rows,
        bytesOut: terminalSessions.bytesOut,
        truncated: terminalSessions.truncated,
        exitCode: terminalSessions.exitCode,
        endReason: terminalSessions.endReason,
        chunk: sql<string>`substr("transcript", ${offset + 1})`,
        length: sql<number>`length("transcript")`,
      })
      .from(terminalSessions)
      .where(and(eq(terminalSessions.id, id), eq(terminalSessions.serverId, serverId)))
      .limit(1);
    if (!row) return null;
    const { chunk, length, ...rest } = row;
    return { ...toInfo({ ...rest, transcript: '' }), transcript: chunk, offset, length: Number(length) };
  }

  /** Старые сессии удаляются при открытии новой — без отдельной джобы. */
  async prune(): Promise<void> {
    const cutoff = new Date(Date.now() - TERMINAL_HISTORY_DAYS * 86_400_000);
    await this.db.delete(terminalSessions).where(lt(terminalSessions.startedAt, cutoff));
  }
}
