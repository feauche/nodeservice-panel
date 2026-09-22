import { Inject, Injectable } from '@nestjs/common';
import type { AuditEntry, AuditFilter, AuditListQuery, AuditListResponse } from '@nodeservice/shared';
import { and, asc, desc, eq, gt, gte, inArray, lte, type SQL, sql } from 'drizzle-orm';

import { DB, type Db } from '../../infra/db/db.module.js';
import { type AuditRow, auditLog } from './audit.table.js';

const EXPORT_BATCH = 1000;
const REPLAY_MAX = 500;

/** Чтение Журнала: страницы, догон для SSE, потоковая выгрузка. Запись — только в AuditService. */
@Injectable()
export class AuditRepository {
  constructor(@Inject(DB) private readonly db: Db) {}

  toEntry(row: AuditRow): AuditEntry {
    return {
      id: row.id,
      seq: Number(row.seq),
      occurredAt: row.occurredAt.toISOString(),
      actorType: row.actorType as AuditEntry['actorType'],
      actorId: row.actorId,
      actorDisplay: row.actorDisplay,
      action: row.action,
      category: row.category as AuditEntry['category'],
      targetType: row.targetType,
      targetId: row.targetId,
      targetDisplay: row.targetDisplay,
      result: row.result as AuditEntry['result'],
      severity: row.severity as AuditEntry['severity'],
      source: row.source as AuditEntry['source'],
      ip: row.ip,
      userAgent: row.userAgent,
      requestId: row.requestId,
      durationMs: row.durationMs,
      changes: row.changes ?? null,
      metadata: row.metadata ?? {},
    };
  }

  private where(f: AuditFilter): SQL | undefined {
    const conds: SQL[] = [];
    if (f.category) conds.push(inArray(auditLog.category, f.category));
    if (f.result) conds.push(inArray(auditLog.result, f.result));
    if (f.source) conds.push(eq(auditLog.source, f.source));
    if (f.actorType) conds.push(eq(auditLog.actorType, f.actorType));
    if (f.targetId) conds.push(eq(auditLog.targetId, f.targetId));
    if (f.from) conds.push(gte(auditLog.occurredAt, new Date(f.from)));
    if (f.to) conds.push(lte(auditLog.occurredAt, new Date(f.to)));
    if (f.q) conds.push(sql`${auditLog}."search" @@ websearch_to_tsquery('simple', ${f.q})`);
    return conds.length ? and(...conds) : undefined;
  }

  /** Номерная пагинация, новые сверху. COUNT(*) по фильтру — см. оговорку в docs. */
  async list(query: AuditListQuery): Promise<AuditListResponse> {
    const where = this.where(query);
    const [countRow] = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(auditLog)
      .where(where);
    const total = countRow?.count ?? 0;
    const totalPages = Math.max(0, Math.ceil(total / query.pageSize));
    const page = totalPages === 0 ? 1 : Math.min(query.page, totalPages);
    const rows = await this.db
      .select()
      .from(auditLog)
      .where(where)
      .orderBy(desc(auditLog.occurredAt), desc(auditLog.id))
      .limit(query.pageSize)
      .offset((page - 1) * query.pageSize);
    return { items: rows.map((r) => this.toEntry(r)), page, pageSize: query.pageSize, total, totalPages };
  }

  /** Записи после seq (догон SSE по Last-Event-ID), по возрастанию. */
  async since(seq: number, limit = REPLAY_MAX): Promise<AuditEntry[]> {
    const rows = await this.db
      .select()
      .from(auditLog)
      .where(gt(auditLog.seq, seq))
      .orderBy(asc(auditLog.seq))
      .limit(limit);
    return rows.map((r) => this.toEntry(r));
  }

  /** Потоковая выгрузка по фильтру: keyset-пачки по EXPORT_BATCH, память не растёт. */
  async *iterate(filter: AuditFilter, max: number, signal?: AbortSignal): AsyncGenerator<AuditEntry> {
    const base = this.where(filter);
    let cursor: { occurredAt: Date; id: string } | null = null;
    let sent = 0;
    while (sent < max) {
      if (signal?.aborted) return;
      const keyset: SQL | undefined = cursor
        ? sql`(${auditLog.occurredAt}, ${auditLog.id}) < (${cursor.occurredAt}, ${cursor.id}::uuid)`
        : undefined;
      const rows: AuditRow[] = await this.db
        .select()
        .from(auditLog)
        .where(keyset ? (base ? and(base, keyset) : keyset) : base)
        .orderBy(desc(auditLog.occurredAt), desc(auditLog.id))
        .limit(Math.min(EXPORT_BATCH, max - sent));
      if (rows.length === 0) return;
      for (const row of rows) {
        yield this.toEntry(row);
        sent++;
      }
      const last = rows[rows.length - 1];
      if (!last) return;
      cursor = { occurredAt: last.occurredAt, id: last.id };
    }
  }
}
