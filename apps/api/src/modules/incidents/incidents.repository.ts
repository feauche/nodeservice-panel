import { Inject, Injectable } from '@nestjs/common';
import {
  INCIDENT_KINDS,
  type IncidentEvent,
  type IncidentKind,
  type IncidentSeverity,
  type IncidentSnapshot,
} from '@nodeservice/shared';
import { and, desc, eq, gte, inArray, ne, or, type SQL, sql } from 'drizzle-orm';

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

export interface IncidentActionStat {
  kind: string;
  runs: number;
  helped: number;
  lastAt: string | null;
}

/** Событие ноды, с которым она вошла в какую-либо волну (её строка волны показывает его сама). */
const WAVE_MEMBER = sql`exists (
  select 1 from ${incidents} as w
  cross join lateral jsonb_array_elements(coalesce(w.snapshot->'fleet'->'members', '[]'::jsonb)) as m
  where w.kind = 'wave' and m->>'incidentId' = ${incidents.id}::text
)`;
/** Событие ноды, которая сейчас лежит в открытой волне (любое её событие тех видов, что собираются в волну). */
const OPEN_WAVE_MEMBER = sql`(${incidents.kind} in ('node_down', 'node_blocked', 'server_down') and exists (
  select 1 from ${incidents} as w
  cross join lateral jsonb_array_elements(coalesce(w.snapshot->'fleet'->'members', '[]'::jsonb)) as m
  where w.kind = 'wave' and w.status <> 'resolved' and m->>'nodeUuid' = ${incidents.nodeUuid}::text
    and m->>'upAt' is null
))`;

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

  /** Только строки с реально идущей попыткой; сторожу не нужно читать всю годовую историю каждые 30 с. */
  async withRunningAttempts(): Promise<IncidentRow[]> {
    return this.db
      .select()
      .from(incidents)
      .where(sql`exists (
        select 1 from jsonb_array_elements(${incidents.attempts}) as attempt
        where attempt->>'status' = 'running'
      )`);
  }

  /** Статистика автопочинки считается PostgreSQL по элементам JSON, а не полными строками в Node.js. */
  async actionStatsSince(since: Date): Promise<IncidentActionStat[]> {
    const result = await this.db.execute<{
      kind: string;
      runs: number;
      helped: number;
      last_at: Date | string | null;
    }>(sql`
      select i.kind,
             count(*)::int as runs,
             count(*) filter (where attempt->>'status' = 'helped')::int as helped,
             max((attempt->>'startedAt')::timestamptz) as last_at
      from incidents as i
      cross join lateral jsonb_array_elements(i.attempts) as attempt
      where (attempt->>'startedAt')::timestamptz >= ${since}
      group by i.kind
    `);
    return result.rows.map((row) => ({
      kind: row.kind,
      runs: Number(row.runs),
      helped: Number(row.helped),
      // pg может вернуть timestamptz как Date или строку `2026-10-02 15:15:46+00`. Контракт API
      // требует ISO с T и Z независимо от настройки парсера драйвера.
      lastAt: row.last_at === null ? null : new Date(row.last_at).toISOString(),
    }));
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
    /** `grouped` — события нод, вошедших в волну, не повторяются: их показывает строка волны (0.106.0). */
    waves?: 'flat' | 'grouped';
  }): Promise<IncidentsPage> {
    const where = and(
      this.where(query.status, query.openedFrom),
      inArray(incidents.kind, [...INCIDENT_KINDS]),
      query.waves === 'grouped' ? sql`not ${WAVE_MEMBER}` : undefined,
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
    return (
      this.db
        .select({
          status: incidents.status,
          openedAt: incidents.openedAt,
          resolvedAt: incidents.resolvedAt,
          resolvedBy: incidents.resolvedBy,
          attempts: incidents.attempts,
        })
        .from(incidents)
        // Волна — не отдельный сбой, а группа уже посчитанных сбоев нод.
        .where(and(gte(incidents.openedAt, openedFrom), ne(incidents.kind, 'wave')))
    );
  }

  /** Открытая волна считается за одно событие: события её нод в счётчиках (значок «События») не повторяются. */
  async counts(): Promise<{ open: number; crit: number; warn: number }> {
    const live = and(ne(incidents.status, 'resolved'), sql`not ${OPEN_WAVE_MEMBER}`);
    const [open] = await this.db.select({ n: sql<number>`count(*)::int` }).from(incidents).where(live);
    const [crit] = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(incidents)
      .where(and(live, eq(incidents.severity, 'crit')));
    const [warn] = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(incidents)
      .where(and(live, eq(incidents.severity, 'warn')));
    return { open: open?.n ?? 0, crit: crit?.n ?? 0, warn: warn?.n ?? 0 };
  }

  async findById(id: string): Promise<IncidentRow | undefined> {
    return this.db.query.incidents.findFirst({ where: eq(incidents.id, id) });
  }

  async open(values: {
    nodeUuid?: string;
    diagnostics?: import('@nodeservice/shared').NodeTcpDiagnostics | null;
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

  /** Последнее событие ноды: открытое или в работе; с `resolvedSince` — и закрытое не раньше этого времени. */
  async latestForNode(nodeUuid: string, resolvedSince: Date | null = null): Promise<IncidentRow | undefined> {
    const active = inArray(incidents.status, ['open', 'acknowledged']);
    return this.db.query.incidents.findFirst({
      where: and(
        eq(incidents.nodeUuid, nodeUuid),
        resolvedSince ? or(active, gte(incidents.resolvedAt, resolvedSince)) : active,
      ),
      orderBy: desc(incidents.openedAt),
    });
  }

  /** Дописать строку в хронологию одним запросом: параллельные записи друг друга не затирают. */
  async appendTimeline(id: string, event: import('@nodeservice/shared').IncidentEvent) {
    const [row] = await this.db
      .update(incidents)
      .set({ timeline: sql`${incidents.timeline} || ${JSON.stringify([event])}::jsonb` })
      .where(eq(incidents.id, id))
      .returning({ id: incidents.id, title: incidents.title });
    if (row) this.events.emit({ type: 'incident', data: { id } });
    return row;
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
}
