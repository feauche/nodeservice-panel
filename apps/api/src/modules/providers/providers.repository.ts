import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';

import { DB, type Db } from '../../infra/db/db.module.js';
import { type ProviderRow, providers } from '../../infra/db/schema/index.js';

export type ProviderWithCount = ProviderRow;

@Injectable()
export class ProvidersRepository {
  constructor(@Inject(DB) private readonly db: Db) {}

  async list(): Promise<ProviderWithCount[]> {
    const rows = await this.db
      .select()
      .from(providers)
      .where(and(isNull(providers.archivedAt), isNull(providers.remotePanel)))
      .orderBy(asc(providers.name));
    return rows.sort((a, b) => a.name.localeCompare(b.name, 'ru'));
  }

  async findById(id: string): Promise<ProviderWithCount | undefined> {
    const row = await this.db.query.providers.findFirst({
      where: and(eq(providers.id, id), isNull(providers.archivedAt), isNull(providers.remotePanel)),
    });
    return row;
  }

  /** Провайдеры, у которых поиск иконки не завершился (например, API перезапустили). */
  async listIconPending(): Promise<ProviderRow[]> {
    return this.db
      .select()
      .from(providers)
      .where(and(eq(providers.iconPending, true), isNull(providers.archivedAt)));
  }

  async findByName(name: string): Promise<ProviderRow | undefined> {
    return this.db.query.providers.findFirst({
      where: and(isNull(providers.remotePanel), sql`lower(${providers.name}) = lower(${name})`),
    });
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
        iconPending: false,
        iconVersion: sql`${providers.iconVersion} + 1`,
        updatedAt: new Date(),
      })
      .where(eq(providers.id, id))
      .returning();
    return row;
  }

  /** Скрыть провайдера, сохранив FK у старых оплат и платежей. */
  async archive(id: string): Promise<boolean> {
    const rows = await this.db
      .update(providers)
      .set({ archivedAt: new Date(), iconPending: false, updatedAt: new Date() })
      .where(and(eq(providers.id, id), isNull(providers.archivedAt), isNull(providers.remotePanel)))
      .returning({ id: providers.id });
    return rows.length > 0;
  }
}
