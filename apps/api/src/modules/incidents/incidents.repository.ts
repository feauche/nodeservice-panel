import { Inject, Injectable } from '@nestjs/common';
import type { IncidentEvent, IncidentKind, IncidentSeverity } from '@nodeservice/shared';
import { and, desc, eq, ne } from 'drizzle-orm';

import { DB, type Db } from '../../infra/db/db.module.js';
import { type IncidentRow, incidents } from '../../infra/db/schema/index.js';

/** Хранилище инцидентов. Один открытый инцидент на (server_id, kind) держит частичный уникальный индекс. */
@Injectable()
export class IncidentsRepository {
  constructor(@Inject(DB) private readonly db: Db) {}

  async list(status: 'all' | 'open' | 'resolved'): Promise<IncidentRow[]> {
    const rows = await this.db.select().from(incidents).orderBy(desc(incidents.openedAt)).limit(200);
    if (status === 'open') return rows.filter((r) => r.status !== 'resolved');
    if (status === 'resolved') return rows.filter((r) => r.status === 'resolved');
    return rows;
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

  async open(values: {
    serverId: string | null;
    serverName: string;
    kind: IncidentKind;
    severity: IncidentSeverity;
    title: string;
    detail: string;
    timeline: IncidentEvent[];
  }): Promise<IncidentRow | undefined> {
    // onConflictDoNothing по частичному индексу: гонка двух тиков не заведёт дубль.
    const [row] = await this.db.insert(incidents).values(values).onConflictDoNothing().returning();
    return row;
  }

  async update(id: string, patch: Partial<typeof incidents.$inferInsert>): Promise<IncidentRow | undefined> {
    const [row] = await this.db.update(incidents).set(patch).where(eq(incidents.id, id)).returning();
    return row;
  }

  async appendEvent(id: string, event: IncidentEvent): Promise<IncidentRow | undefined> {
    const row = await this.findById(id);
    if (!row) return undefined;
    return this.update(id, { timeline: [...row.timeline, event] });
  }
}
