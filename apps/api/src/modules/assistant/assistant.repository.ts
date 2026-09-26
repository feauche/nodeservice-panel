import { Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq, ne } from 'drizzle-orm';

import { DB, type Db } from '../../infra/db/db.module.js';
import {
  type AssistantConversationRow,
  type AssistantMessageRow,
  assistantConversations,
  assistantMessages,
} from '../../infra/db/schema/index.js';

import type { PastMessage } from './assistant.conversation-search.js';

@Injectable()
export class AssistantRepository {
  constructor(@Inject(DB) private readonly db: Db) {}

  async createConversation(title: string): Promise<AssistantConversationRow> {
    const [row] = await this.db.insert(assistantConversations).values({ title }).returning();
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

  /** Свежие сообщения всех бесед (новые сверху) для поиска по прошлым чатам; текущую беседу можно исключить. */
  async recentMessages(limit: number, excludeConversationId?: string): Promise<PastMessage[]> {
    return this.db
      .select({
        conversationId: assistantMessages.conversationId,
        title: assistantConversations.title,
        role: assistantMessages.role,
        content: assistantMessages.content,
        createdAt: assistantMessages.createdAt,
      })
      .from(assistantMessages)
      .innerJoin(assistantConversations, eq(assistantConversations.id, assistantMessages.conversationId))
      .where(
        excludeConversationId ? and(ne(assistantMessages.conversationId, excludeConversationId)) : undefined,
      )
      .orderBy(desc(assistantMessages.createdAt))
      .limit(limit);
  }

  async addMessage(values: typeof assistantMessages.$inferInsert): Promise<AssistantMessageRow> {
    const [row] = await this.db.insert(assistantMessages).values(values).returning();
    if (!row) throw new Error('Не удалось сохранить сообщение');
    return row;
  }
}
