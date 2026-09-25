import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, sql } from 'drizzle-orm';

import { DB, type Db } from '../../infra/db/db.module.js';
import {
  type KbDocumentRow,
  type KbDocumentVersionRow,
  kbDocuments,
  kbDocumentVersions,
} from '../../infra/db/schema/index.js';

@Injectable()
export class KnowledgeRepository {
  constructor(@Inject(DB) private readonly db: Db) {}

  async list(q: string | undefined, archived: boolean): Promise<KbDocumentRow[]> {
    if (q && q.length > 0) {
      return this.db
        .select()
        .from(kbDocuments)
        .where(and(eq(kbDocuments.archived, archived), sql`search @@ websearch_to_tsquery('simple', ${q})`))
        .orderBy(desc(kbDocuments.pinned), sql`ts_rank(search, websearch_to_tsquery('simple', ${q})) DESC`)
        .limit(50);
    }
    return this.db
      .select()
      .from(kbDocuments)
      .where(eq(kbDocuments.archived, archived))
      .orderBy(desc(kbDocuments.pinned), desc(kbDocuments.updatedAt))
      .limit(200);
  }

  /** Топ-K статей для контекста Джарвиса (RAG-lite по FTS). */
  async searchForContext(q: string, limit = 4): Promise<KbDocumentRow[]> {
    return this.db
      .select()
      .from(kbDocuments)
      .where(and(eq(kbDocuments.archived, false), sql`search @@ websearch_to_tsquery('simple', ${q})`))
      .orderBy(sql`ts_rank(search, websearch_to_tsquery('simple', ${q})) DESC`)
      .limit(limit);
  }

  async findById(id: string): Promise<KbDocumentRow | undefined> {
    return this.db.query.kbDocuments.findFirst({ where: eq(kbDocuments.id, id) });
  }

  /** Найти статью по точному заголовку (для служебной статьи-глоссария «Пояснения»). */
  async findByTitle(title: string): Promise<KbDocumentRow | undefined> {
    return this.db.query.kbDocuments.findFirst({ where: eq(kbDocuments.title, title) });
  }

  async insert(values: typeof kbDocuments.$inferInsert): Promise<KbDocumentRow> {
    const [row] = await this.db.insert(kbDocuments).values(values).returning();
    if (!row) throw new Error('Не удалось создать статью');
    return row;
  }

  async update(
    id: string,
    patch: Partial<typeof kbDocuments.$inferInsert>,
  ): Promise<KbDocumentRow | undefined> {
    const [row] = await this.db
      .update(kbDocuments)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(kbDocuments.id, id))
      .returning();
    return row;
  }

  async delete(id: string): Promise<boolean> {
    const rows = await this.db
      .delete(kbDocuments)
      .where(eq(kbDocuments.id, id))
      .returning({ id: kbDocuments.id });
    return rows.length > 0;
  }

  /** Снимок состояния статьи в историю версий (для отката). */
  async insertVersion(values: typeof kbDocumentVersions.$inferInsert): Promise<void> {
    await this.db.insert(kbDocumentVersions).values(values);
  }

  /** История версий статьи, новые сверху. */
  async listVersions(docId: string, limit = 50): Promise<KbDocumentVersionRow[]> {
    return this.db
      .select()
      .from(kbDocumentVersions)
      .where(eq(kbDocumentVersions.docId, docId))
      .orderBy(desc(kbDocumentVersions.createdAt))
      .limit(limit);
  }

  async findVersion(id: string): Promise<KbDocumentVersionRow | undefined> {
    const [row] = await this.db
      .select()
      .from(kbDocumentVersions)
      .where(eq(kbDocumentVersions.id, id))
      .limit(1);
    return row;
  }
}
