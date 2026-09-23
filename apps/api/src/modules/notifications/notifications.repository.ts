import { Inject, Injectable } from '@nestjs/common';
import { NOTIFICATIONS_LIMIT } from '@nodeservice/shared';
import { desc, eq, isNull, lt, sql } from 'drizzle-orm';

import { DB, type Db } from '../../infra/db/db.module.js';
import { type NotificationRow, notifications } from '../../infra/db/schema/index.js';

@Injectable()
export class NotificationsRepository {
  constructor(@Inject(DB) private readonly db: Db) {}

  async list(): Promise<{ items: NotificationRow[]; unread: number; total: number }> {
    const [items, [counts]] = await Promise.all([
      this.db.select().from(notifications).orderBy(desc(notifications.createdAt)).limit(NOTIFICATIONS_LIMIT),
      this.db
        .select({
          total: sql<number>`count(*)::int`,
          unread: sql<number>`count(*) filter (where ${notifications.readAt} is null)::int`,
        })
        .from(notifications),
    ]);
    return { items, unread: Number(counts?.unread ?? 0), total: Number(counts?.total ?? 0) };
  }

  async insert(values: typeof notifications.$inferInsert): Promise<NotificationRow> {
    const [row] = await this.db.insert(notifications).values(values).returning();
    if (!row) throw new Error('Не удалось сохранить уведомление');
    return row;
  }

  async markAllRead(): Promise<void> {
    await this.db.update(notifications).set({ readAt: new Date() }).where(isNull(notifications.readAt));
  }

  async delete(id: string): Promise<boolean> {
    const rows = await this.db
      .delete(notifications)
      .where(eq(notifications.id, id))
      .returning({ id: notifications.id });
    return rows.length > 0;
  }

  async clear(): Promise<number> {
    return (await this.db.delete(notifications).returning({ id: notifications.id })).length;
  }

  async deleteOlderThan(threshold: Date): Promise<number> {
    return (
      await this.db
        .delete(notifications)
        .where(lt(notifications.createdAt, threshold))
        .returning({ id: notifications.id })
    ).length;
  }
}
