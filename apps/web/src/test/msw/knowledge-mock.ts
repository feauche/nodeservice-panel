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

// Шаблон из api (modules/knowledge/fleet-rules.ts) с одной записью владельца под первым разделом.
const FLEET_RULES_MOCK = `# Правила парка

> Здесь владелец записывает то, что Джарвис обязан учитывать в вашей схеме. Он читает эту статью в начале каждой беседы и не меняет её сам. Пишите коротко и по делу.

## Критичные серверы
- ru-entry-1: единственный вход для LTE

## Окна обслуживания и допустимые перерывы
_Когда можно обновлять и перезагружать, сколько простоя допустимо._

## Что нельзя менять без согласования
_Например: порты нод, конфиг-профили, DNS._

## Что считается нормой
_Обычная нагрузка, трафик, число соединений, особенности по времени суток._

## Особенности провайдеров и маршрутов
_Резервные маршруты, известные проблемы хостеров, куда переключать при сбое._

## Принятые решения
_Что решили и почему, чтобы не возвращаться к обсуждённому._
`;

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
      title: 'Пояснения',
      content:
        '# Пояснения\n\nКороткий словарь терминов и аббревиатур — что это простыми словами. Пополняется Джарвисом автоматически.\n\n| Термин | Простыми словами |\n| --- | --- |\n| conntrack | Таблица соединений в ядре |\n| SSH | Безопасный удалённый доступ к серверу |\n',
      tags: ['глоссарий'],
      archived: false,
      pinned: true,
      source: 'ai',
      createdAt: iso(20),
      updatedAt: iso(20),
    },
    {
      id: uid(),
      title: 'Правила парка',
      content: FLEET_RULES_MOCK,
      tags: ['правила'],
      archived: false,
      pinned: true,
      source: 'self',
      createdAt: iso(3),
      updatedAt: iso(3),
    },
    {
      id: uid(),
      title: 'Лимит conntrack',
      content:
        '# Лимит conntrack\n\nЕсли таблица **conntrack** близка к пределу, поднимите лимит:\n\n```bash\nsysctl -w net.netfilter.nf_conntrack_max=1048576\n```\n\nПроверить текущее значение: `sysctl net.netfilter.nf_conntrack_count`.',
      tags: ['conntrack', 'сеть'],
      archived: false,
      pinned: false,
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
      pinned: false,
      source: 'ai',
      createdAt: iso(14),
      updatedAt: iso(5),
    },
    {
      id: uid(),
      title: 'Очистка диска ноды',
      content:
        '# Очистка диска ноды\n\nКогда диск заполняется:\n\n- `journalctl --vacuum-size=200M`\n- `docker system prune -f`\n\nЛоги Xray обычно занимают больше всего.',
      tags: ['диск', 'обслуживание'],
      archived: false,
      pinned: false,
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
      pinned: false,
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
    items = [...items].sort(
      (a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt.localeCompare(a.updatedAt),
    );
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
      pinned: false,
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
    const patch = (await request.json()) as Partial<KbDoc>;
    if (current.pinned && patch.archived === true)
      return kbProblem(409, 'Служебную статью нельзя отправить в архив.');
    snapshotVersion(current, 'edit');
    const next: KbDoc = { ...current, ...patch, updatedAt: new Date().toISOString() };
    mockKnowledge.items[idx] = next;
    return HttpResponse.json(next);
  }),
  http.delete('/api/knowledge/:id', ({ params }) => {
    if (mockKnowledge.items.find((d) => d.id === params.id)?.pinned)
      return kbProblem(409, 'Служебную статью нельзя удалить.');
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
