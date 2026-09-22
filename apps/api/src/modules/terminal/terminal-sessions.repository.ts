import { Inject, Injectable } from '@nestjs/common';
import {
  TERMINAL_HISTORY_DAYS,
  TERMINAL_TRANSCRIPT_MAX,
  type TerminalSessionDetail,
  type TerminalSessionInfo,
} from '@nodeservice/shared';
import { and, desc, eq, gte, lt, type SQL, sql } from 'drizzle-orm';

import { DB, type Db } from '../../infra/db/db.module.js';
import { type TerminalSessionRow, terminalSessions } from '../../infra/db/schema/index.js';

/**
 * Те же правила очистки, что в apps/web/src/lib/strip-ansi.ts, но для Postgres: сначала убираются
 * управляющие последовательности (CSI, OSC, одиночные ESC-команды, BEL), затем «\r без \n»
 * схлопывается до последнего кадра строки. Управляющие символы переданы как есть, а не как
 * \x-экранирование, чтобы не зависеть от диалекта регулярок.
 */
const PG_ANSI_RE =
  '\u001b\\[[0-?]*[ -/]*[@-~]|\u001b\\][^\u0007\u001b]*(?:\u0007|\u001b\\\\)|\u001b[ -/]*[0-~]|\u0007';
const PG_CR_FRAME_RE = '[^\r\n]*\r(?=[^\n])';
const PG_CR_TAIL_RE = '\r(?=\n|$)';

/** SQL-выражение: запись сессии как видит её человек, в нижнем регистре — для подсчёта совпадений. */
function plainTranscript(): SQL<string> {
  return sql<string>`lower(regexp_replace(regexp_replace(regexp_replace("transcript", ${PG_ANSI_RE}, '', 'g'), ${PG_CR_FRAME_RE}, '', 'g'), ${PG_CR_TAIL_RE}, '', 'g'))`;
}

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

  /**
   * Сессии сервера, свежие первыми. С `since` — только начатые не раньше этой даты. С `q` — только
   * те, где строка встречается в очищенной записи, и у каждой `matches` — сколько раз (без регистра,
   * непересекающиеся вхождения: как считает и клиент при подсветке).
   */
  async list(
    serverId: string,
    limit: number,
    opts: { q?: string; since?: Date } = {},
  ): Promise<TerminalSessionInfo[]> {
    const conds = [eq(terminalSessions.serverId, serverId)];
    if (opts.since) conds.push(gte(terminalSessions.startedAt, opts.since));
    const q = opts.q?.toLowerCase() ?? '';
    if (q === '') {
      const rows = await this.db
        .select()
        .from(terminalSessions)
        .where(and(...conds))
        .orderBy(desc(terminalSessions.startedAt))
        .limit(limit);
      return rows.map(toInfo);
    }
    const plain = plainTranscript();
    const matches = sql<number>`(length(${plain}) - length(replace(${plain}, ${q}, ''))) / ${q.length}`;
    const rows = await this.db
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
        matches,
      })
      .from(terminalSessions)
      .where(and(...conds, sql`position(${q} in ${plain}) > 0`))
      .orderBy(desc(terminalSessions.startedAt))
      .limit(limit);
    return rows.map(({ matches: m, ...r }) => ({ ...toInfo({ ...r, transcript: '' }), matches: Number(m) }));
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
