import { HttpStatus, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
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
import { FLEET_RULES_TEMPLATE, FLEET_RULES_TITLE, fleetRulesText } from './fleet-rules.js';
import { type IncomingTerm, mergeTerms } from './glossary-merge.js';
import { KnowledgeRepository } from './knowledge.repository.js';

/** База знаний: CRUD markdown-статей с полнотекстовым поиском. */
@Injectable()
export class KnowledgeService implements OnModuleInit {
  private readonly log = new Logger(KnowledgeService.name);

  constructor(
    private readonly repo: KnowledgeRepository,
    private readonly audit: AuditService,
  ) {}

  /** Глоссарий «Пояснения» есть всегда и закреплён: Джарвис читает его и пополняет. */
  async onModuleInit(): Promise<void> {
    try {
      await this.ensureGlossary();
    } catch (err) {
      this.log.warn(`Не удалось подготовить глоссарий: ${err instanceof Error ? err.message : err}`);
    }
    try {
      await this.ensureFleetRules();
    } catch (err) {
      this.log.warn(`Не удалось подготовить «Правила парка»: ${err instanceof Error ? err.message : err}`);
    }
  }

  /** «Правила парка» есть всегда и закреплены: пишет владелец, Джарвис только читает. */
  async ensureFleetRules(): Promise<KbDocumentRow> {
    const existing = await this.repo.findByTitle(FLEET_RULES_TITLE);
    if (existing) {
      if (existing.pinned && !existing.archived) return existing;
      return (await this.repo.update(existing.id, { pinned: true, archived: false })) ?? existing;
    }
    return this.repo.insert({
      title: FLEET_RULES_TITLE,
      content: FLEET_RULES_TEMPLATE,
      tags: ['правила'],
      source: 'self',
      pinned: true,
    });
  }

  /** Текст правил для инструкции Джарвиса; null — владелец ещё ничего не написал. */
  async fleetRules(): Promise<string | null> {
    const doc = await this.repo.findByTitle(FLEET_RULES_TITLE);
    return doc ? fleetRulesText(doc.content) : null;
  }

  async ensureGlossary(): Promise<KbDocumentRow> {
    const existing = await this.repo.findByTitle(GLOSSARY_TITLE);
    if (existing) {
      if (existing.pinned && !existing.archived) return existing;
      return (await this.repo.update(existing.id, { pinned: true, archived: false })) ?? existing;
    }
    return this.repo.insert({
      title: GLOSSARY_TITLE,
      content: renderGlossary([]),
      tags: ['глоссарий'],
      source: 'ai',
      pinned: true,
    });
  }

  private toDoc(row: KbDocumentRow): KbDoc {
    return {
      id: row.id,
      title: row.title,
      content: row.content,
      tags: row.tags ?? [],
      archived: row.archived,
      pinned: row.pinned,
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
      pinned: row.pinned,
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
    // Служебные статьи одни на всех: вторую с тем же названием не заводим, иначе непонятно, какую читать.
    if (RESERVED_TITLES.has(input.title.trim()) && (await this.repo.findByTitle(input.title.trim())))
      throw problem(HttpStatus.CONFLICT, {
        detail: 'Такая служебная статья уже есть: откройте её и измените.',
      });
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
    if (before.pinned && patch.archived === true)
      throw problem(HttpStatus.CONFLICT, { detail: 'Служебную статью нельзя отправить в архив.' });
    if (before.pinned && patch.title !== undefined && patch.title !== before.title)
      throw problem(HttpStatus.CONFLICT, {
        detail: 'Название служебной статьи менять нельзя: по нему её находит Джарвис.',
      });
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
    terms: IncomingTerm[],
    opts?: { auditSource?: AuditSource },
  ): Promise<{ id: string; added: number; skipped: string[]; updated: string[] }> {
    const existing = await this.repo.findByTitle(GLOSSARY_TITLE);
    const merged = mergeTerms(existing ? parseGlossary(existing.content) : [], terms);
    const changed = merged.added.length + merged.updated.length > 0;
    const content = renderGlossary(merged.entries);
    const result = { added: merged.added.length, skipped: merged.skipped, updated: merged.updated };

    if (existing) {
      // Ничего нового и ничего не исправлено: статью не трогаем, лишней версии в истории не будет.
      if (!changed) return { id: existing.id, ...result };
      const row = await this.repo.update(existing.id, { content });
      await this.audit.record({
        action: 'kb.updated',
        target: { type: 'kb', id: existing.id, display: GLOSSARY_TITLE },
        ...(opts?.auditSource ? { source: opts.auditSource } : {}),
      });
      return { id: row?.id ?? existing.id, ...result };
    }
    const doc = await this.ensureGlossary();
    if (changed) await this.repo.update(doc.id, { content });
    return { id: doc.id, ...result };
  }

  async remove(id: string): Promise<void> {
    const row = await this.repo.findById(id);
    if (!row) throw problem(HttpStatus.NOT_FOUND, { detail: 'Статья не найдена.' });
    if (row.pinned) throw problem(HttpStatus.CONFLICT, { detail: 'Служебную статью нельзя удалить.' });
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
/** Названия служебных закреплённых статей: обычную статью с таким названием не создаём. */
const RESERVED_TITLES = new Set([GLOSSARY_TITLE, FLEET_RULES_TITLE]);
const GLOSSARY_HEADER = `# Пояснения

Короткий словарь терминов и аббревиатур — что это простыми словами. Пополняется Джарвисом автоматически.

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
