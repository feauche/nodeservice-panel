import { HttpStatus, Injectable } from '@nestjs/common';
import type {
  AuditSource,
  KbDoc,
  KbDocCreate,
  KbDocSummary,
  KbDocUpdate,
  KbVersion,
} from '@nodeservice/shared';

import { problem } from '../../common/filters/problem-details.filter.js';
import type { KbDocumentRow } from '../../infra/db/schema/index.js';
import { diffChanges } from '../audit/audit.diff.js';
import { AuditService } from '../audit/audit.service.js';
import { KnowledgeRepository } from './knowledge.repository.js';

/** База знаний: CRUD markdown-статей с полнотекстовым поиском. */
@Injectable()
export class KnowledgeService {
  constructor(
    private readonly repo: KnowledgeRepository,
    private readonly audit: AuditService,
  ) {}

  private toDoc(row: KbDocumentRow): KbDoc {
    return {
      id: row.id,
      title: row.title,
      content: row.content,
      tags: row.tags ?? [],
      archived: row.archived,
      source: row.source,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  private toSummary(row: KbDocumentRow): KbDocSummary {
    const text = row.content
      .replace(/[#*`>_-]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    return {
      id: row.id,
      title: row.title,
      tags: row.tags ?? [],
      archived: row.archived,
      source: row.source,
      excerpt: text.slice(0, 160),
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  async list(q: string | undefined, archived: boolean): Promise<KbDocSummary[]> {
    return (await this.repo.list(q, archived)).map((r) => this.toSummary(r));
  }

  async get(id: string): Promise<KbDoc> {
    const row = await this.repo.findById(id);
    if (!row) throw problem(HttpStatus.NOT_FOUND, { detail: 'Статья не найдена.' });
    return this.toDoc(row);
  }

  async create(input: KbDocCreate, opts?: { auditSource?: AuditSource }): Promise<KbDoc> {
    const row = await this.repo.insert({
      title: input.title,
      content: input.content,
      tags: input.tags,
      source: input.source,
    });
    await this.audit.record({
      action: 'kb.created',
      target: { type: 'kb', id: row.id, display: row.title },
      // Статью создал агент → в Журнале это «авто», а не «вручную».
      ...(opts?.auditSource ? { source: opts.auditSource } : {}),
    });
    return this.toDoc(row);
  }

  /** Снимок текущего состояния статьи в историю версий — чтобы можно было откатить. */
  private async snapshot(row: KbDocumentRow, reason: string): Promise<void> {
    await this.repo.insertVersion({
      docId: row.id,
      title: row.title,
      content: row.content,
      tags: row.tags ?? [],
      source: row.source,
      archived: row.archived,
      reason,
    });
  }

  async update(id: string, patch: KbDocUpdate, opts?: { reason?: string }): Promise<KbDoc> {
    const before = await this.repo.findById(id);
    if (!before) throw problem(HttpStatus.NOT_FOUND, { detail: 'Статья не найдена.' });
    // Перед изменением сохраняем предыдущее состояние в историю версий.
    await this.snapshot(before, opts?.reason ?? 'edit');
    const defined = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
    const row = await this.repo.update(id, defined);
    if (!row) throw problem(HttpStatus.NOT_FOUND, { detail: 'Статья не найдена.' });
    await this.audit.record({
      action: 'kb.updated',
      target: { type: 'kb', id, display: row.title },
      changes: diffChanges(
        { title: before.title, tags: before.tags, archived: before.archived, source: before.source },
        { title: row.title, tags: row.tags, archived: row.archived, source: row.source },
      ),
    });
    return this.toDoc(row);
  }

  /**
   * Пополнить служебный глоссарий «Пояснения» (таблица «термин → простое объяснение»).
   * Дубликаты (по термину, без учёта регистра) не добавляются. Создаёт статью, если её ещё нет.
   */
  async appendGlossary(
    terms: Array<{ term: string; explain: string }>,
    opts?: { auditSource?: AuditSource },
  ): Promise<{ id: string; added: number }> {
    const existing = await this.repo.findByTitle(GLOSSARY_TITLE);
    const byKey = new Map<string, { term: string; explain: string }>();
    if (existing) for (const r of parseGlossary(existing.content)) byKey.set(r.term.toLowerCase(), r);

    let added = 0;
    for (const t of terms) {
      const term = t.term.trim();
      const explain = t.explain
        .trim()
        .replace(/\s*\|\s*/g, '/')
        .replace(/\s+/g, ' ');
      if (!term || !explain || byKey.has(term.toLowerCase())) continue;
      byKey.set(term.toLowerCase(), { term, explain });
      added += 1;
    }
    const content = renderGlossary([...byKey.values()].sort((a, b) => a.term.localeCompare(b.term, 'ru')));

    if (existing) {
      const row = await this.repo.update(existing.id, { content });
      if (added > 0)
        await this.audit.record({
          action: 'kb.updated',
          target: { type: 'kb', id: existing.id, display: GLOSSARY_TITLE },
          ...(opts?.auditSource ? { source: opts.auditSource } : {}),
        });
      return { id: row?.id ?? existing.id, added };
    }
    const doc = await this.create(
      { title: GLOSSARY_TITLE, content, tags: ['глоссарий'], source: 'ai' },
      opts,
    );
    return { id: doc.id, added };
  }

  async remove(id: string): Promise<void> {
    const row = await this.repo.findById(id);
    if (!row) throw problem(HttpStatus.NOT_FOUND, { detail: 'Статья не найдена.' });
    await this.repo.delete(id);
    await this.audit.record({
      action: 'kb.deleted',
      severity: 'warn',
      target: { type: 'kb', id, display: row.title },
    });
  }

  /** История версий статьи (для отката). */
  async versions(id: string): Promise<KbVersion[]> {
    const rows = await this.repo.listVersions(id);
    return rows.map((v) => ({
      id: v.id,
      title: v.title,
      reason: v.reason,
      createdAt: v.createdAt.toISOString(),
    }));
  }

  /** Откатить статью к сохранённой версии (текущее состояние тоже уходит в историю). */
  async revert(id: string, versionId: string): Promise<KbDoc> {
    const current = await this.repo.findById(id);
    if (!current) throw problem(HttpStatus.NOT_FOUND, { detail: 'Статья не найдена.' });
    const ver = await this.repo.findVersion(versionId);
    if (!ver || ver.docId !== id) throw problem(HttpStatus.NOT_FOUND, { detail: 'Версия не найдена.' });
    await this.snapshot(current, 'revert');
    const row = await this.repo.update(id, {
      title: ver.title,
      content: ver.content,
      tags: ver.tags ?? [],
      source: ver.source,
      archived: ver.archived,
    });
    if (!row) throw problem(HttpStatus.NOT_FOUND, { detail: 'Статья не найдена.' });
    await this.audit.record({
      action: 'kb.reverted',
      target: { type: 'kb', id, display: row.title },
      metadata: { versionCreatedAt: ver.createdAt.toISOString() },
    });
    return this.toDoc(row);
  }
}

/** Служебная статья-глоссарий. Заголовок фиксирован — по нему её находим и пополняем. */
const GLOSSARY_TITLE = 'Пояснения';
const GLOSSARY_HEADER = `# Пояснения

Короткий словарь терминов и аббревиатур — что это простыми словами. Пополняется ассистентом автоматически.

| Термин | Простыми словами |
| --- | --- |`;

/** Разобрать строки таблицы глоссария из markdown (пропуская шапку и разделитель). */
function parseGlossary(content: string): Array<{ term: string; explain: string }> {
  const rows: Array<{ term: string; explain: string }> = [];
  for (const line of content.split('\n')) {
    const m = /^\s*\|(.+?)\|(.+?)\|\s*$/.exec(line);
    if (!m) continue;
    const term = (m[1] ?? '').trim();
    const explain = (m[2] ?? '').trim();
    if (!term || term === 'Термин' || /^:?-+:?$/.test(term)) continue;
    rows.push({ term, explain });
  }
  return rows;
}

/** Собрать содержимое глоссария из строк (шапка + markdown-таблица). */
function renderGlossary(rows: Array<{ term: string; explain: string }>): string {
  const body = rows.map((r) => `| ${r.term} | ${r.explain} |`).join('\n');
  return `${GLOSSARY_HEADER}\n${body}\n`;
}
