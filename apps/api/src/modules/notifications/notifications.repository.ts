import { Inject, Injectable } from '@nestjs/common';
import { NOTIFICATIONS_LIMIT } from '@nodeservice/shared';
import { desc, eq, isNull, lt, sql } from 'drizzle-orm';

import { DB, type Db } from '../../infra/db/db.module.js';
import { type NotificationRow, notifications, servers } from '../../infra/db/schema/index.js';

/** Строка уведомления + актуальное имя сервера (null — сервер удалён или уведомление не про сервер). */
export type NotificationWithServer = NotificationRow & { serverNameNow: string | null };

@Injectable()
export class NotificationsRepository {
  constructor(@Inject(DB) private readonly db: Db) {}

  async list(): Promise<{ items: NotificationWithServer[]; unread: number; total: number }> {
    const [rows, [counts]] = await Promise.all([
      this.db
        .select({ n: notifications, serverNameNow: servers.name })
        .from(notifications)
        .leftJoin(servers, eq(notifications.serverId, servers.id))
        .orderBy(desc(notifications.createdAt))
        .limit(NOTIFICATIONS_LIMIT),
      this.db
        .select({
          total: sql<number>`count(*)::int`,
          unread: sql<number>`count(*) filter (where ${notifications.readAt} is null)::int`,
        })
        .from(notifications),
    ]);
    const items = rows.map((r) => ({ ...r.n, serverNameNow: r.serverNameNow }));
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
