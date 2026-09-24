import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, gt, isNull, sql } from 'drizzle-orm';

import { DB, type Db } from '../../infra/db/db.module.js';
import {
  type EnrollmentTokenRow,
  enrollmentTokens,
  providers,
  type ServerRow,
  servers,
} from '../../infra/db/schema/index.js';
import { EventsService } from '../events/events.service.js';

/** Поля, смена которых не меняет карточку: живой поток о них молчит (heartbeat агента идёт часто). */
const SILENT_KEYS = new Set(['agentLastSeenAt', 'lastSshCheckAt', 'updatedAt']);

@Injectable()
export class ServersRepository {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly events: EventsService,
  ) {}

  async list(): Promise<ServerRow[]> {
    return this.db.select().from(servers).orderBy(asc(servers.sortOrder), asc(servers.name));
  }

  async findById(id: string): Promise<ServerRow | undefined> {
    return this.db.query.servers.findFirst({ where: eq(servers.id, id) });
  }

  async findByName(name: string): Promise<ServerRow | undefined> {
    return this.db.query.servers.findFirst({ where: eq(servers.name, name) });
  }

  /** Следующая позиция в конце списка. */
  async nextSortOrder(): Promise<number> {
    const rows = await this.db.select({ max: sql<number | null>`max(${servers.sortOrder})` }).from(servers);
    return (rows[0]?.max ?? -1) + 1;
  }

  /** Раздвинуть хвост: копия встаёт сразу после оригинала. */
  async shiftOrderAfter(sortOrder: number): Promise<void> {
    await this.db
      .update(servers)
      .set({ sortOrder: sql`${servers.sortOrder} + 1` })
      .where(gt(servers.sortOrder, sortOrder));
  }

  /** Новый порядок: названные id — по порядку списка, остальные — следом, сохраняя свой порядок. */
  async setOrder(ids: string[]): Promise<void> {
    const rows = await this.list();
    const wanted = new Map(ids.map((id, i) => [id, i]));
    const mentioned = rows.filter((r) => wanted.has(r.id));
    mentioned.sort((a, b) => (wanted.get(a.id) ?? 0) - (wanted.get(b.id) ?? 0));
    const rest = rows.filter((r) => !wanted.has(r.id));
    await this.db.transaction(async (tx) => {
      let i = 0;
      for (const row of [...mentioned, ...rest]) {
        await tx.update(servers).set({ sortOrder: i }).where(eq(servers.id, row.id));
        i += 1;
      }
    });
  }

  async providerExists(id: string): Promise<boolean> {
    const row = await this.db.query.providers.findFirst({
      where: eq(providers.id, id),
      columns: { id: true },
    });
    return Boolean(row);
  }

  async insert(values: typeof servers.$inferInsert): Promise<ServerRow> {
    const [row] = await this.db.insert(servers).values(values).returning();
    if (!row) throw new Error('Не удалось создать сервер');
    this.events.emit({ type: 'server', data: { id: row.id } });
    return row;
  }

  async update(id: string, patch: Partial<typeof servers.$inferInsert>): Promise<ServerRow | undefined> {
    const [row] = await this.db
      .update(servers)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(servers.id, id))
      .returning();
    if (row && Object.keys(patch).some((k) => !SILENT_KEYS.has(k)))
      this.events.emit({ type: 'server', data: { id } });
    return row;
  }

  async delete(id: string): Promise<boolean> {
    const rows = await this.db.delete(servers).where(eq(servers.id, id)).returning({ id: servers.id });
    if (rows.length > 0) this.events.emit({ type: 'server', data: { id } });
    return rows.length > 0;
  }

  /* ---------- токены агента ---------- */

  async insertEnrollmentToken(values: typeof enrollmentTokens.$inferInsert): Promise<EnrollmentTokenRow> {
    const [row] = await this.db.insert(enrollmentTokens).values(values).returning();
    if (!row) throw new Error('Не удалось выпустить токен');
    return row;
  }

  /** Отозвать все живые токены сервера (новый токен заменяет старые). */
  async revokeActiveTokens(serverId: string): Promise<number> {
    const rows = await this.db
      .update(enrollmentTokens)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(enrollmentTokens.serverId, serverId),
          isNull(enrollmentTokens.revokedAt),
          gt(enrollmentTokens.expiresAt, new Date()),
        ),
      )
      .returning({ id: enrollmentTokens.id });
    return rows.length;
  }

  /** Токен одноразовый: пометить использованным. */
  async markEnrollmentUsed(id: string): Promise<void> {
    await this.db.update(enrollmentTokens).set({ usedAt: new Date() }).where(eq(enrollmentTokens.id, id));
  }

  async findEnrollmentByHash(tokenHash: string): Promise<EnrollmentTokenRow | undefined> {
    return this.db.query.enrollmentTokens.findFirst({ where: eq(enrollmentTokens.tokenHash, tokenHash) });
  }
}
