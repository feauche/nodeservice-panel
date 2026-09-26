import { beforeEach, describe, expect, it } from 'vitest';

import type { KbDocumentRow } from '../../infra/db/schema/index.js';
import { KnowledgeService } from './knowledge.service.js';

interface Version {
  id: string;
  docId: string;
  title: string;
  content: string;
  reason: string | null;
  createdAt: Date;
}

function make() {
  let n = 0;
  const docs = new Map<string, KbDocumentRow>();
  const versions: Version[] = [];
  const audit: Array<Record<string, unknown>> = [];
  const repo = {
    async findByTitle(title: string) {
      return [...docs.values()].find((d) => d.title === title);
    },
    async findById(id: string) {
      return docs.get(id);
    },
    async insert(v: Partial<KbDocumentRow>) {
      n += 1;
      const row = {
        id: `doc-${n}`,
        content: '',
        tags: [],
        archived: false,
        pinned: false,
        source: 'self',
        createdAt: new Date(),
        updatedAt: new Date(),
        ...v,
      } as KbDocumentRow;
      docs.set(row.id, row);
      return row;
    },
    async update(id: string, patch: Partial<KbDocumentRow>) {
      const row = docs.get(id);
      if (!row) return undefined;
      Object.assign(row, patch, { updatedAt: new Date() });
      return row;
    },
    async insertVersion(v: Omit<Version, 'id' | 'createdAt'>) {
      n += 1;
      versions.unshift({ id: `ver-${n}`, createdAt: new Date(), ...v });
    },
    async listVersions(docId: string, limit = 50) {
      return versions.filter((v) => v.docId === docId).slice(0, limit);
    },
  };
  const auditSvc = { record: async (e: Record<string, unknown>) => void audit.push(e) };
  const svc = new KnowledgeService(repo as never, auditSvc as never);
  return { svc, docs, versions, audit };
}

const term = (t: string, explain = `${t} — пояснение`) => ({ term: t, explain });

describe('KnowledgeService: пополнение глоссария и история версий', () => {
  let ctx: ReturnType<typeof make>;
  beforeEach(async () => {
    ctx = make();
    await ctx.svc.ensureGlossary();
  });
  const glossary = () => [...ctx.docs.values()].find((d) => d.title === 'Пояснения') as KbDocumentRow;

  const age = (v: Version | undefined, min = 20) => {
    if (v) v.createdAt = new Date(Date.now() - min * 60_000);
  };

  it('первое пополнение пишет версию с пустым словарём (к нему можно откатиться) и запись в Журнал', async () => {
    await ctx.svc.appendGlossary([term('SSH')], { auditSource: 'auto' });
    expect(glossary().content).toContain('SSH');
    expect(ctx.versions).toHaveLength(1);
    expect(ctx.versions[0]).toMatchObject({ reason: 'glossary', title: 'Пояснения' });
    expect(ctx.versions[0]?.content).not.toContain('SSH');
    expect(ctx.audit[0]).toMatchObject({
      action: 'kb.updated',
      source: 'auto',
      metadata: { via: 'glossary', added: ['SSH'] },
    });
  });

  it('пополнение словаря с терминами пишет версию с прежним текстом, она видна в истории статьи', async () => {
    await ctx.svc.appendGlossary([term('SSH')]);
    age(ctx.versions[0]);
    const before = glossary().content;
    await ctx.svc.appendGlossary([term('CPU')], { auditSource: 'auto' });
    expect(ctx.versions).toHaveLength(2);
    expect(ctx.versions[0]).toMatchObject({ reason: 'glossary', content: before });
    expect(ctx.versions[0]?.content).toContain('SSH');
    expect(ctx.versions[0]?.content).not.toContain('CPU');
    expect(glossary().content).toContain('CPU');
    expect(ctx.audit.at(-1)).toMatchObject({ metadata: { via: 'glossary', added: ['CPU'], skipped: 0 } });
    const listed = await ctx.svc.versions(glossary().id);
    expect(listed.map((v) => v.reason)).toEqual(['glossary', 'glossary']);
  });

  it('серия пополнений подряд даёт одну версию (состояние до серии), а через десять минут уже новую', async () => {
    await ctx.svc.appendGlossary([term('SSH')]);
    await ctx.svc.appendGlossary([term('CPU')]);
    await ctx.svc.appendGlossary([term('RAM')]);
    await ctx.svc.appendGlossary([term('DNS')]);
    expect(ctx.versions).toHaveLength(1);
    expect(ctx.versions[0]?.content).not.toContain('SSH');
    age(ctx.versions[0], 11);
    await ctx.svc.appendGlossary([term('TCP')]);
    expect(ctx.versions).toHaveLength(2);
    expect(ctx.versions[0]?.content).toContain('DNS');
  });

  it('повторы без изменений не пишут ни версию, ни запись в Журнал', async () => {
    await ctx.svc.appendGlossary([term('SSH')]);
    await ctx.svc.appendGlossary([term('CPU')]);
    const versions = ctx.versions.length;
    const audit = ctx.audit.length;
    const r = await ctx.svc.appendGlossary([term('ssh'), term('CPU')]);
    expect(r).toMatchObject({ added: 0, skipped: ['SSH', 'CPU'] });
    expect(ctx.versions).toHaveLength(versions);
    expect(ctx.audit).toHaveLength(audit);
  });

  it('исправление пояснения (update) попадает в версию и в Журнал', async () => {
    await ctx.svc.appendGlossary([term('SSH', 'Старое пояснение')]);
    age(ctx.versions[0]);
    await ctx.svc.appendGlossary([term('CPU')]);
    age(ctx.versions[0]);
    const r = await ctx.svc.appendGlossary([{ term: 'SSH', explain: 'Новое пояснение', update: true }]);
    expect(r.updated).toEqual(['SSH']);
    expect(ctx.versions).toHaveLength(3);
    expect(ctx.versions[0]?.content).toContain('Старое пояснение');
    expect(ctx.audit.at(-1)).toMatchObject({ metadata: { updated: ['SSH'] } });
  });

  it('ручная правка между пополнениями разрывает серию: следующее пополнение пишет свою версию', async () => {
    await ctx.svc.appendGlossary([term('SSH')]);
    await ctx.svc.appendGlossary([term('CPU')]);
    expect(ctx.versions.map((v) => v.reason)).toEqual(['glossary']);
    await ctx.svc.update(glossary().id, { content: `${glossary().content}\n| Ручной | Термин |` });
    expect(ctx.versions.map((v) => v.reason)).toEqual(['edit', 'glossary']);
    await ctx.svc.appendGlossary([term('RAM')]);
    expect(ctx.versions.map((v) => v.reason)).toEqual(['glossary', 'edit', 'glossary']);
    expect(ctx.versions[0]?.content).toContain('Ручной');
  });
});
