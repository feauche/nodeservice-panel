import type { KbDoc } from '@nodeservice/shared';
import { HttpResponse, http } from 'msw';

interface KbVersionSnap {
  id: string;
  title: string;
  content: string;
  tags: string[];
  source: KbDoc['source'];
  archived: boolean;
  reason: string;
  createdAt: string;
}
interface KbMock {
  items: KbDoc[];
  versions: Record<string, KbVersionSnap[]>;
}
export const mockKnowledge: KbMock = { items: [], versions: {} };

/** Снимок текущего состояния статьи в историю (как на сервере — перед изменением). */
function snapshotVersion(doc: KbDoc, reason: string): void {
  const list = mockKnowledge.versions[doc.id] ?? [];
  list.unshift({
    id: uid(),
    title: doc.title,
    content: doc.content,
    tags: doc.tags,
    source: doc.source,
    archived: doc.archived,
    reason,
    createdAt: new Date().toISOString(),
  });
  mockKnowledge.versions[doc.id] = list;
}

let seq = 0;
const uid = () => {
  seq += 1;
  return `0192e000-0000-7000-8000-${String(seq).padStart(12, '0')}`;
};
const iso = (daysAgo: number) => new Date(Date.now() - daysAgo * 86_400_000).toISOString();

export function seedKnowledge(): void {
  seq = 0;
  mockKnowledge.versions = {};
  mockKnowledge.items = [
    {
      id: uid(),
      title: 'Лимит conntrack',
      content:
        '# Лимит conntrack\n\nЕсли таблица **conntrack** близка к пределу, подними лимит:\n\n```bash\nsysctl -w net.netfilter.nf_conntrack_max=1048576\n```\n\nПроверить текущее значение: `sysctl net.netfilter.nf_conntrack_count`.',
      tags: ['conntrack', 'сеть'],
      archived: false,
      source: 'web',
      createdAt: iso(9),
      updatedAt: iso(2),
    },
    {
      id: uid(),
      title: 'Перезапуск Xray',
      content:
        '# Перезапуск Xray\n\nПри падении процесса:\n\n1. `systemctl restart xray`\n2. Если нода в контейнере — `docker restart remnanode`\n3. Проверить логи: `journalctl -u xray -n 100`',
      tags: ['xray', 'runbook'],
      archived: false,
      source: 'ai',
      createdAt: iso(14),
      updatedAt: iso(5),
    },
    {
      id: uid(),
      title: 'Очистка диска ноды',
      content:
        '# Очистка диска\n\nКогда диск заполняется:\n\n- `journalctl --vacuum-size=200M`\n- `docker system prune -f`\n\nЛоги Xray обычно занимают больше всего.',
      tags: ['диск', 'обслуживание'],
      archived: false,
      source: 'self',
      createdAt: iso(20),
      updatedAt: iso(11),
    },
    {
      id: uid(),
      title: 'Старая заметка (архив)',
      content: '# Архив\n\nУстаревшая инструкция.',
      tags: ['архив'],
      archived: true,
      source: 'telegram',
      createdAt: iso(60),
      updatedAt: iso(40),
    },
  ];
  // Пара версий для первой статьи — чтобы история была не пустой.
  const first = mockKnowledge.items[0];
  if (first)
    mockKnowledge.versions[first.id] = [
      {
        id: uid(),
        title: first.title,
        content: first.content,
        tags: first.tags,
        source: first.source,
        archived: false,
        reason: 'edit',
        createdAt: iso(1),
      },
      {
        id: uid(),
        title: first.title,
        content: '# Лимит conntrack\n\nСтарый вариант.',
        tags: first.tags,
        source: first.source,
        archived: false,
        reason: 'review',
        createdAt: iso(3),
      },
    ];
}

function toSummary(d: KbDoc) {
  const excerpt = d.content
    .replace(/[#*`>_-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160);
  const { content: _content, ...rest } = d;
  return { ...rest, excerpt };
}

function kbProblem(status: number, detail: string) {
  return HttpResponse.json(
    { type: 'about:blank', title: detail, status, detail },
    { status, headers: { 'content-type': 'application/problem+json' } },
  );
}

export const knowledgeHandlers = [
  http.get('/api/knowledge', ({ request }) => {
    const url = new URL(request.url);
    const q = (url.searchParams.get('q') ?? '').trim().toLowerCase();
    const archived = url.searchParams.get('archived') === 'true';
    let items = mockKnowledge.items.filter((d) => d.archived === archived);
    if (q)
      items = items.filter((d) => d.title.toLowerCase().includes(q) || d.content.toLowerCase().includes(q));
    items = [...items].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return HttpResponse.json({ items: items.map(toSummary) });
  }),
  http.post('/api/knowledge', async ({ request }) => {
    const body = (await request.json()) as {
      title: string;
      content?: string;
      tags?: string[];
      source?: KbDoc['source'];
    };
    const now = new Date().toISOString();
    const doc: KbDoc = {
      id: uid(),
      title: body.title,
      content: body.content ?? '',
      tags: body.tags ?? [],
      archived: false,
      source: body.source ?? 'self',
      createdAt: now,
      updatedAt: now,
    };
    mockKnowledge.items = [doc, ...mockKnowledge.items];
    return HttpResponse.json(doc, { status: 201 });
  }),
  http.get('/api/knowledge/:id', ({ params }) => {
    const doc = mockKnowledge.items.find((d) => d.id === params.id);
    return doc ? HttpResponse.json(doc) : kbProblem(404, 'Статья не найдена.');
  }),
  http.put('/api/knowledge/:id', async ({ params, request }) => {
    const idx = mockKnowledge.items.findIndex((d) => d.id === params.id);
    if (idx < 0) return kbProblem(404, 'Статья не найдена.');
    const current = mockKnowledge.items[idx] as KbDoc;
    snapshotVersion(current, 'edit');
    const patch = (await request.json()) as Partial<KbDoc>;
    const next: KbDoc = { ...current, ...patch, updatedAt: new Date().toISOString() };
    mockKnowledge.items[idx] = next;
    return HttpResponse.json(next);
  }),
  http.delete('/api/knowledge/:id', ({ params }) => {
    mockKnowledge.items = mockKnowledge.items.filter((d) => d.id !== params.id);
    delete mockKnowledge.versions[String(params.id)];
    return new HttpResponse(null, { status: 204 });
  }),
  http.get('/api/knowledge/:id/versions', ({ params }) => {
    const list = mockKnowledge.versions[String(params.id)] ?? [];
    return HttpResponse.json({
      items: list.map((v) => ({ id: v.id, title: v.title, reason: v.reason, createdAt: v.createdAt })),
    });
  }),
  http.post('/api/knowledge/:id/versions/:versionId/revert', ({ params }) => {
    const idx = mockKnowledge.items.findIndex((d) => d.id === params.id);
    if (idx < 0) return kbProblem(404, 'Статья не найдена.');
    const ver = (mockKnowledge.versions[String(params.id)] ?? []).find((v) => v.id === params.versionId);
    if (!ver) return kbProblem(404, 'Версия не найдена.');
    const current = mockKnowledge.items[idx] as KbDoc;
    snapshotVersion(current, 'revert');
    const next: KbDoc = {
      ...current,
      title: ver.title,
      content: ver.content,
      tags: ver.tags,
      source: ver.source,
      archived: ver.archived,
      updatedAt: new Date().toISOString(),
    };
    mockKnowledge.items[idx] = next;
    return HttpResponse.json(next);
  }),
];

// Доступ к стору из скриншот-скриптов/отладки (как у прочих моков).
if (typeof window !== 'undefined')
  (window as unknown as { __nsMockKnowledge: KbMock }).__nsMockKnowledge = mockKnowledge;
