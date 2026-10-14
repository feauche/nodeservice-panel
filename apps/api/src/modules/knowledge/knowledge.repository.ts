import { Inject, Injectable } from '@nestjs/common';
import type { KbVersionSummary } from '@nodeservice/shared';
import { and, desc, eq, type SQL, sql } from 'drizzle-orm';

import { DB, type Db } from '../../infra/db/db.module.js';
import {
  type KbDocumentRow,
  type KbDocumentVersionRow,
  kbDocuments,
  kbDocumentVersions,
} from '../../infra/db/schema/index.js';

/** Слова запроса без знаков синтаксиса поиска; не больше 8. */
function queryWords(q: string): string[] {
  return q
    .toLowerCase()
    .split(/\s+/)
    .map((w) => w.replace(/[^\p{L}\p{N}.@_-]/gu, '').replace(/^[.@_-]+|[.@_-]+$/g, ''))
    .filter(Boolean)
    .slice(0, 8);
}

/**
 * Запрос по словам: каждое слово ищется как есть и по основе (русская морфология: «блокировка» находит
 * «Блокировки»), длинные — ещё и как начало слова. all — нужны все слова (поиск владельца); иначе любое
 * (подбор статей Ассистенту по фразе вроде «блокировка ТСПУ» — лучшие наверху по рангу). null — слов нет.
 */
export function kbTsQuery(q: string, all: boolean): SQL | null {
  const words = queryWords(q).filter((w) => all || w.length >= 2);
  if (!words.length) return null;
  const parts = words.map((w) => {
    const lexeme = `'${w.replace(/'/g, "''")}'${w.length >= 3 ? ':*' : ''}`;
    return sql`(to_tsquery('simple', ${lexeme}) || to_tsquery('russian', ${lexeme}))`;
  });
  return sql`(${sql.join(parts, all ? sql` && ` : sql` || `)})`;
}

@Injectable()
export class KnowledgeRepository {
  constructor(@Inject(DB) private readonly db: Db) {}

  async list(q: string | undefined, archived: boolean): Promise<KbDocumentRow[]> {
    const query = q ? kbTsQuery(q, true) : null;
    if (query) {
      return this.db
        .select()
        .from(kbDocuments)
        .where(and(eq(kbDocuments.archived, archived), sql`search @@ ${query}`))
        .orderBy(desc(kbDocuments.pinned), sql`ts_rank(search, ${query}) DESC`)
        .limit(50);
    }
    return this.db
      .select()
      .from(kbDocuments)
      .where(eq(kbDocuments.archived, archived))
      .orderBy(desc(kbDocuments.pinned), desc(kbDocuments.updatedAt))
      .limit(200);
  }

  /** Топ-K статей для контекста Ассистента (RAG-lite по FTS): подходит любое слово, лучшие — по рангу. */
  async searchForContext(q: string, limit = 4): Promise<KbDocumentRow[]> {
    const query = kbTsQuery(q, false);
    if (!query) return [];
    return this.db
      .select()
      .from(kbDocuments)
      .where(and(eq(kbDocuments.archived, false), sql`search @@ ${query}`))
      .orderBy(sql`ts_rank(search, ${query}) DESC`)
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

  /** Досчитать сводку уже существующего снимка (серия пополнений глоссария в одном окне истории). */
  async updateVersionSummary(id: string, summary: KbVersionSummary): Promise<void> {
    await this.db.update(kbDocumentVersions).set({ summary }).where(eq(kbDocumentVersions.id, id));
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
