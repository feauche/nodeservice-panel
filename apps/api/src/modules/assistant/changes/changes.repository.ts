import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, gte, sql } from 'drizzle-orm';

import { DB, type Db } from '../../../infra/db/db.module.js';
import { type AssistantChangeRow, assistantChanges } from '../../../infra/db/schema/index.js';

@Injectable()
export class ChangesRepository {
  constructor(@Inject(DB) private readonly db: Db) {}

  async insert(v: typeof assistantChanges.$inferInsert): Promise<AssistantChangeRow> {
    const [row] = await this.db.insert(assistantChanges).values(v).returning();
    if (!row) throw new Error('Не удалось сохранить изменение');
    return row;
  }

  async find(id: string): Promise<AssistantChangeRow | undefined> {
    return this.db.query.assistantChanges.findFirst({ where: eq(assistantChanges.id, id) });
  }

  async update(
    id: string,
    patch: Partial<Pick<AssistantChangeRow, 'status' | 'note' | 'decidedBy' | 'decidedAt'>>,
  ): Promise<AssistantChangeRow | undefined> {
    const [row] = await this.db
      .update(assistantChanges)
      .set(patch)
      .where(eq(assistantChanges.id, id))
      .returning();
    return row;
  }

  /** Такое же ожидающее решения изменение в этой беседе: повторная карточка не нужна. */
  async findPending(conversationId: string, operation: string): Promise<AssistantChangeRow[]> {
    return this.db
      .select()
      .from(assistantChanges)
      .where(
        and(
          eq(assistantChanges.conversationId, conversationId),
          eq(assistantChanges.operation, operation),
          eq(assistantChanges.status, 'proposed'),
        ),
      )
      .orderBy(desc(assistantChanges.createdAt))
      .limit(20);
  }

  /** Число изменений по статусам за период (для сводки в настройках). */
  async countsSince(since: Date): Promise<Array<{ status: string; n: number }>> {
    return this.db
      .select({ status: assistantChanges.status, n: sql<number>`count(*)::int` })
      .from(assistantChanges)
      .where(gte(assistantChanges.createdAt, since))
      .groupBy(assistantChanges.status);
  }
}
