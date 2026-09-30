import { Inject, Injectable } from '@nestjs/common';
import {
  INCIDENT_KINDS,
  type IncidentAnalysis,
  type IncidentEvent,
  type IncidentKind,
  type IncidentSeverity,
  type IncidentSnapshot,
} from '@nodeservice/shared';
import { and, desc, eq, gte, inArray, max, ne, type SQL, sql } from 'drizzle-orm';

import { DB, type Db } from '../../infra/db/db.module.js';
import { type IncidentRow, incidents } from '../../infra/db/schema/index.js';
import { EventsService } from '../events/events.service.js';

type IncidentStatusFilter = 'all' | 'open' | 'resolved';
export interface IncidentsPage {
  items: IncidentRow[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

/** Хранилище инцидентов. Один открытый инцидент на (server_id, kind) держит частичный уникальный индекс. */
@Injectable()
export class IncidentsRepository {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly events: EventsService,
  ) {}

  private where(status: IncidentStatusFilter, openedFrom?: string): SQL | undefined {
    const conds: SQL[] = [];
    if (status === 'open') conds.push(ne(incidents.status, 'resolved'));
    if (status === 'resolved') conds.push(eq(incidents.status, 'resolved'));
    if (openedFrom) conds.push(gte(incidents.openedAt, new Date(openedFrom)));
    return conds.length ? and(...conds) : undefined;
  }

  /** Список целиком, без разбивки на страницы — для внутренних служб (джобы, ассистент). */
  async list(status: IncidentStatusFilter): Promise<IncidentRow[]> {
    return this.db
      .select()
      .from(incidents)
      .where(this.where(status))
      .orderBy(desc(incidents.openedAt), desc(incidents.id));
  }

  /**
   * Тот же список, но постранично — для HTTP-ручки. «Открытые» всё равно приходят целиком (их немного,
   * резать их пополам между страницами не нужно), режутся только «Все»/«Решённые».
   * Только виды из контракта — и в счёте, и в выборке: запись вида, которого уже нет (после переименований),
   * выброшенная после нарезки, сдвигала бы листание по смещению и расходилась с общим числом.
   */
  async listPage(query: {
    status: IncidentStatusFilter;
    openedFrom?: string | undefined;
    page: number;
    pageSize: number;
    /** С какой строки начать (с нуля); задано — `page` не учитывается и к последней странице не подгоняется. */
    offset?: number | undefined;
  }): Promise<IncidentsPage> {
    const where = and(
      this.where(query.status, query.openedFrom),
      inArray(incidents.kind, [...INCIDENT_KINDS]),
    );
    if (query.status === 'open') {
      const rows = await this.db.select().from(incidents).where(where).orderBy(desc(incidents.openedAt));
      return {
        items: rows,
        page: 1,
        pageSize: Math.max(rows.length, 1),
        total: rows.length,
        totalPages: rows.length > 0 ? 1 : 0,
      };
    }
    const [countRow] = await this.db.select({ n: sql<number>`count(*)::int` }).from(incidents).where(where);
    const total = countRow?.n ?? 0;
    const totalPages = Math.max(0, Math.ceil(total / query.pageSize));
    // По смещению строка задана точно: за концом списка — пусто, а не «последняя страница» (клиент сам
    // решает, куда вернуться). Номер страницы в ответе — та, куда попадает первая строка.
    const page =
      query.offset !== undefined
        ? Math.floor(query.offset / query.pageSize) + 1
        : totalPages === 0
          ? 1
          : Math.min(query.page, totalPages);
    const rows = await this.db
      .select()
      .from(incidents)
      .where(where)
      .orderBy(desc(incidents.openedAt), desc(incidents.id))
      .limit(query.pageSize)
      .offset(query.offset ?? (page - 1) * query.pageSize);
    return { items: rows, page, pageSize: query.pageSize, total, totalPages };
  }

  /** Счётчики для шапки — всегда по всей таблице, независимо от текущей страницы/фильтра. */
  /** Лёгкая выборка для полосы «за 7 дней»: только поля подсчёта, без разборов и хронологии. */
  async weekRows(openedFrom: Date) {
    return this.db
      .select({
        status: incidents.status,
        openedAt: incidents.openedAt,
        resolvedAt: incidents.resolvedAt,
        resolvedBy: incidents.resolvedBy,
        attempts: incidents.attempts,
      })
      .from(incidents)
      .where(gte(incidents.openedAt, openedFrom));
  }

  async counts(): Promise<{ open: number; crit: number; warn: number }> {
    const [open] = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(incidents)
      .where(ne(incidents.status, 'resolved'));
    const [crit] = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(incidents)
      .where(and(ne(incidents.status, 'resolved'), eq(incidents.severity, 'crit')));
    const [warn] = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(incidents)
      .where(and(ne(incidents.status, 'resolved'), eq(incidents.severity, 'warn')));
    return { open: open?.n ?? 0, crit: crit?.n ?? 0, warn: warn?.n ?? 0 };
  }

  async findById(id: string): Promise<IncidentRow | undefined> {
    return this.db.query.incidents.findFirst({ where: eq(incidents.id, id) });
  }

  async findOpen(serverId: string | null, kind: IncidentKind): Promise<IncidentRow | undefined> {
    const rows = await this.db
      .select()
      .from(incidents)
      .where(
        and(
          serverId ? eq(incidents.serverId, serverId) : undefined,
          eq(incidents.kind, kind),
          ne(incidents.status, 'resolved'),
        ),
      );
    return rows[0];
  }

  /**
   * Когда панель последний раз сама запускала починку этого сигнала на сервере — по всем его делам, включая
   * закрытые: пауза между автопочинками считается по серверу и виду сигнала, а не по одному делу.
   */
  async lastAutofixAt(serverId: string, kind: string): Promise<Date | null> {
    const [row] = await this.db
      .select({ at: max(incidents.lastAutofixAt) })
      .from(incidents)
      .where(and(eq(incidents.serverId, serverId), eq(incidents.kind, kind)));
    return row?.at ?? null;
  }

  async open(values: {
    serverId: string | null;
    serverName: string;
    kind: IncidentKind;
    severity: IncidentSeverity;
    title: string;
    detail: string;
    timeline: IncidentEvent[];
    snapshot?: IncidentSnapshot | null;
  }): Promise<IncidentRow | undefined> {
    // onConflictDoNothing по частичному индексу: гонка двух тиков не заведёт дубль.
    const [row] = await this.db.insert(incidents).values(values).onConflictDoNothing().returning();
    if (row) this.events.emit({ type: 'incident', data: { id: row.id } });
    return row;
  }

  async update(id: string, patch: Partial<typeof incidents.$inferInsert>): Promise<IncidentRow | undefined> {
    const [row] = await this.db.update(incidents).set(patch).where(eq(incidents.id, id)).returning();
    if (row) this.events.emit({ type: 'incident', data: { id } });
    return row;
  }

  /**
   * Записать ход разбора, только если в инциденте всё ещё этот же идущий разбор. Отменённый или запущенный
   * заново разбор не трогаем: иначе запоздавший ответ модели затёр бы «отменён». false — писать некуда.
   */
  async updateRunningAnalysis(id: string, startedAt: string, analysis: IncidentAnalysis): Promise<boolean> {
    const rows = await this.db
      .update(incidents)
      .set({ analysis })
      .where(
        and(
          eq(incidents.id, id),
          sql`${incidents.analysis}->>'status' = 'running'`,
          sql`${incidents.analysis}->>'startedAt' = ${startedAt}`,
        ),
      )
      .returning({ id: incidents.id });
    if (rows.length > 0) this.events.emit({ type: 'incident', data: { id } });
    return rows.length > 0;
  }

  async delete(id: string): Promise<boolean> {
    const rows = await this.db.delete(incidents).where(eq(incidents.id, id)).returning({ id: incidents.id });
    if (rows.length > 0) this.events.emit({ type: 'incident', data: { id } });
    return rows.length > 0;
  }

  async deleteResolved(): Promise<number> {
    const n = (
      await this.db.delete(incidents).where(eq(incidents.status, 'resolved')).returning({ id: incidents.id })
    ).length;
    this.events.emit({ type: 'incident', data: { id: 'resolved' } });
    return n;
  }

  async appendEvent(id: string, event: IncidentEvent): Promise<IncidentRow | undefined> {
    const row = await this.findById(id);
    if (!row) return undefined;
    return this.update(id, { timeline: [...row.timeline, event] });
  }
}
