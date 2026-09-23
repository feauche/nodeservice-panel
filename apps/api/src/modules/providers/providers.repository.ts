import { Inject, Injectable } from '@nestjs/common';
import { asc, eq, isNotNull, sql } from 'drizzle-orm';

import { DB, type Db } from '../../infra/db/db.module.js';
import { type ProviderRow, providers, servers } from '../../infra/db/schema/index.js';

export type ProviderWithCount = ProviderRow & { serversCount: number };

@Injectable()
export class ProvidersRepository {
  constructor(@Inject(DB) private readonly db: Db) {}

  /** Число серверов по провайдерам одним запросом — без коррелированных подзапросов. */
  private async counts(): Promise<Map<string, number>> {
    const rows = await this.db
      .select({ providerId: servers.providerId, n: sql<number>`count(*)::int` })
      .from(servers)
      .where(isNotNull(servers.providerId))
      .groupBy(servers.providerId);
    return new Map(rows.map((r) => [r.providerId as string, Number(r.n)]));
  }

  async list(): Promise<ProviderWithCount[]> {
    const [rows, counts] = await Promise.all([
      this.db.select().from(providers).orderBy(asc(providers.name)),
      this.counts(),
    ]);
    return rows.map((r) => ({ ...r, serversCount: counts.get(r.id) ?? 0 }));
  }

  async findById(id: string): Promise<ProviderWithCount | undefined> {
    const row = await this.db.query.providers.findFirst({ where: eq(providers.id, id) });
    if (!row) return undefined;
    const [{ n } = { n: 0 }] = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(servers)
      .where(eq(servers.providerId, id));
    return { ...row, serversCount: Number(n) };
  }

  async findByName(name: string): Promise<ProviderRow | undefined> {
    return this.db.query.providers.findFirst({ where: sql`lower(${providers.name}) = lower(${name})` });
  }

  async insert(values: typeof providers.$inferInsert): Promise<ProviderRow> {
    const [row] = await this.db.insert(providers).values(values).returning();
    if (!row) throw new Error('Не удалось создать провайдера');
    return row;
  }

  async update(id: string, patch: Partial<typeof providers.$inferInsert>): Promise<ProviderRow | undefined> {
    const [row] = await this.db
      .update(providers)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(providers.id, id))
      .returning();
    return row;
  }

  async setIcon(
    id: string,
    icon: { type: string; data: string; sourceUrl: string } | null,
  ): Promise<ProviderRow | undefined> {
    const [row] = await this.db
      .update(providers)
      .set({
        iconType: icon?.type ?? null,
        iconData: icon?.data ?? null,
        iconSourceUrl: icon?.sourceUrl ?? null,
        iconVersion: sql`${providers.iconVersion} + 1`,
        updatedAt: new Date(),
      })
      .where(eq(providers.id, id))
      .returning();
    return row;
  }

  async delete(id: string): Promise<boolean> {
    const rows = await this.db.delete(providers).where(eq(providers.id, id)).returning({ id: providers.id });
    return rows.length > 0;
  }

  /** Серверы провайдера — для карточки в справочнике. */
  async serversOf(id: string): Promise<Array<{ id: string; name: string }>> {
    return this.db
      .select({ id: servers.id, name: servers.name })
      .from(servers)
      .where(eq(servers.providerId, id))
      .orderBy(asc(servers.sortOrder), asc(servers.name));
  }
}
