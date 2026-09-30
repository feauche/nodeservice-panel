import { Inject, Injectable } from '@nestjs/common';
import { type IncidentAnalysis, NOTIFICATIONS_LIMIT } from '@nodeservice/shared';
import { asc, desc, eq, isNull, lt, sql } from 'drizzle-orm';

import { DB, type Db } from '../../infra/db/db.module.js';
import {
  incidents,
  type NotificationRow,
  notifications,
  servers,
  telegramPending,
} from '../../infra/db/schema/index.js';
import type { TelegramDispatch } from './telegram/telegram.service.js';

/** Строка уведомления + актуальное имя сервера (null — сервер удалён или уведомление не про сервер). */
export type NotificationWithServer = NotificationRow & { serverNameNow: string | null };

/** Сообщение в Telegram, которое ждёт разбора Джарвиса, и события того же дела, вставшие за ним в очередь. */
export interface PendingTelegram {
  incidentId: string;
  alert: TelegramDispatch;
  queued: TelegramDispatch[];
  createdAt: Date;
}

/** Что сейчас с делом — по этому решается судьба отложенного сообщения. */
export interface IncidentState {
  status: string;
  openedAt: Date;
  resolvedAt: Date | null;
  analysis: IncidentAnalysis | null;
}

const toPending = (row: typeof telegramPending.$inferSelect): PendingTelegram => ({
  incidentId: row.incidentId,
  alert: row.alert as unknown as TelegramDispatch,
  queued: row.queued as unknown as TelegramDispatch[],
  createdAt: row.createdAt,
});

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

  /* ---------- сообщения Telegram, которые ждут разбора Джарвиса ---------- */

  /**
   * Отложить сообщение о деле. Повтор по тому же делу (дело уточнили) заменяет текст и начинает ожидание
   * заново; события, уже вставшие в очередь, остаются.
   */
  async deferTelegram(incidentId: string, alert: TelegramDispatch): Promise<void> {
    const value = alert as unknown as Record<string, unknown>;
    // Время — по часам панели, а не базы: срок ожидания потом считает сама панель.
    const createdAt = new Date();
    await this.db
      .insert(telegramPending)
      .values({ incidentId, alert: value, createdAt })
      .onConflictDoUpdate({ target: telegramPending.incidentId, set: { alert: value, createdAt } });
  }

  /** Поставить событие того же дела в очередь за отложенным сообщением; false — оно уже не ждёт. */
  async queueTelegram(incidentId: string, m: TelegramDispatch): Promise<boolean> {
    const rows = await this.db
      .update(telegramPending)
      .set({ queued: sql`${telegramPending.queued} || ${JSON.stringify([m])}::jsonb` })
      .where(eq(telegramPending.incidentId, incidentId))
      .returning({ incidentId: telegramPending.incidentId });
    return rows.length > 0;
  }

  async peekTelegram(incidentId: string): Promise<PendingTelegram | null> {
    const [row] = await this.db
      .select()
      .from(telegramPending)
      .where(eq(telegramPending.incidentId, incidentId));
    return row ? toPending(row) : null;
  }

  /** Забрать отложенное и снять признак «ждёт отправки»: достаётся ровно одному, кто бы ни пришёл первым. */
  async takeTelegram(incidentId: string): Promise<PendingTelegram | null> {
    const [row] = await this.db
      .delete(telegramPending)
      .where(eq(telegramPending.incidentId, incidentId))
      .returning();
    return row ? toPending(row) : null;
  }

  async pendingTelegram(): Promise<PendingTelegram[]> {
    const rows = await this.db.select().from(telegramPending).orderBy(asc(telegramPending.createdAt));
    return rows.map(toPending);
  }

  async incidentState(id: string): Promise<IncidentState | null> {
    const [row] = await this.db
      .select({
        status: incidents.status,
        openedAt: incidents.openedAt,
        resolvedAt: incidents.resolvedAt,
        analysis: incidents.analysis,
      })
      .from(incidents)
      .where(eq(incidents.id, id));
    return row ? { ...row, analysis: row.analysis ?? null } : null;
  }
}
