import { Inject, Injectable } from '@nestjs/common';
import type { AssistantMode } from '@nodeservice/shared';
import { asc, desc, eq } from 'drizzle-orm';

import { DB, type Db } from '../../infra/db/db.module.js';
import {
  type AssistantConversationRow,
  type AssistantMessageRow,
  assistantConversations,
  assistantMessages,
} from '../../infra/db/schema/index.js';

@Injectable()
export class AssistantRepository {
  constructor(@Inject(DB) private readonly db: Db) {}

  async createConversation(title: string, mode: AssistantMode): Promise<AssistantConversationRow> {
    const [row] = await this.db.insert(assistantConversations).values({ title, mode }).returning();
    if (!row) throw new Error('Не удалось создать беседу');
    return row;
  }

  async findConversation(id: string): Promise<AssistantConversationRow | undefined> {
    return this.db.query.assistantConversations.findFirst({ where: eq(assistantConversations.id, id) });
  }

  async listConversations(): Promise<AssistantConversationRow[]> {
    return this.db
      .select()
      .from(assistantConversations)
      .orderBy(desc(assistantConversations.createdAt))
      .limit(50);
  }

  async messages(conversationId: string): Promise<AssistantMessageRow[]> {
    return this.db
      .select()
      .from(assistantMessages)
      .where(eq(assistantMessages.conversationId, conversationId))
      .orderBy(asc(assistantMessages.createdAt));
  }

  async addMessage(values: typeof assistantMessages.$inferInsert): Promise<AssistantMessageRow> {
    const [row] = await this.db.insert(assistantMessages).values(values).returning();
    if (!row) throw new Error('Не удалось сохранить сообщение');
    return row;
  }
}
