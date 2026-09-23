import type {
  AssistantConversation,
  AssistantLevel,
  AssistantMessage,
  AssistantMode,
  AssistantPermissions,
  AssistantProvider,
  KbDoc,
} from '@nodeservice/shared';
import { HttpResponse, http } from 'msw';

import { mockIncidents } from './incidents-mock';
import { mockKnowledge } from './knowledge-mock';

interface AssistantMock {
  enabled: boolean;
  provider: AssistantProvider;
  model: string;
  level: AssistantLevel;
  permissions: AssistantPermissions;
  conversations: AssistantConversation[];
  messages: Record<string, AssistantMessage[]>;
}
export const mockAssistant: AssistantMock = {
  enabled: false,
  provider: 'zveno',
  model: 'anthropic/claude-sonnet-4-5',
  level: 'intermediate',
  permissions: { kbWrite: true, glossary: true, kbReview: true },
  conversations: [],
  messages: {},
};

let seq = 0;
const uid = () => {
  seq += 1;
  return `0192f000-0000-7000-8000-${String(seq).padStart(12, '0')}`;
};

if (typeof window !== 'undefined')
  (window as unknown as { __nsMockAssistant: typeof mockAssistant }).__nsMockAssistant = mockAssistant;

export function seedAssistant(): void {
  seq = 0;
  mockAssistant.enabled = false;
  mockAssistant.model = 'claude-sonnet-4-5';
  mockAssistant.level = 'intermediate';
  mockAssistant.permissions = { kbWrite: true, glossary: true, kbReview: true };
  mockAssistant.conversations = [];
  mockAssistant.messages = {};
}

function aProblem(status: number, detail: string) {
  return HttpResponse.json(
    { type: 'about:blank', title: detail, status, detail },
    { status, headers: { 'content-type': 'application/problem+json' } },
  );
}

/** Демо-ответ ассистента: цитаты (база знаний + инцидент) и предложение автопочинки. */
function buildReply(): AssistantMessage {
  const cpu = mockIncidents.items.find((i) => i.kind === 'cpu_high' && i.status !== 'resolved');
  const kb = { type: 'kb' as const, id: '0192e000-0000-7000-8000-000000000001', label: 'Лимит conntrack' };
  const citations: AssistantMessage['citations'] = [kb];
  const proposals: AssistantMessage['proposals'] = [];
  if (cpu) {
    citations.push({ type: 'incident', id: cpu.id, label: cpu.title });
    proposals.push({
      kind: 'autofix',
      incidentId: cpu.id,
      preset: 'restart_node',
      title: 'Перезапустить контейнер ноды',
      description: 'Снимет пиковую нагрузку на CPU на de-fra-01.',
    });
  }
  return {
    id: uid(),
    role: 'assistant',
    content:
      'Сейчас на **de-fra-01** высокая нагрузка на CPU. По базе знаний помогает `перезапуск Xray`. Могу предложить безопасное действие — подтвердишь, и я запущу.',
    citations,
    proposals,
    createdAt: new Date().toISOString(),
  };
}

/** Режим «Анализ»: если разрешено — создаём статью в БЗ и ссылаемся на неё; иначе — про разрешение. */
function buildAnalysisReply(): AssistantMessage {
  const now = new Date().toISOString();
  if (!mockAssistant.permissions.kbWrite) {
    return {
      id: uid(),
      role: 'assistant',
      content:
        'Разбор готов, но создание статей выключено — включи «Настройки → Ассистент → Разрешения». Пока держи черновик в ответе.',
      citations: [],
      proposals: [],
      createdAt: now,
    };
  }
  const article: KbDoc = {
    id: uid(),
    title: 'Настройка Xray Reality (из анализа)',
    content:
      '# Настройка Xray Reality\n\n## Что это\n\nReality — маскировка VLESS под настоящий TLS-сайт.\n\n## Шаги\n\n1. Установи Xray: `bash <(curl -fsSL install)`\n2. Сгенерируй ключи: `xray x25519`\n3. Пропиши `dest` и `serverNames` в конфиг.\n\n```json\n{ "flow": "xtls-rprx-vision" }\n```',
    tags: ['xray', 'reality', 'инструкция'],
    archived: false,
    source: 'ai',
    createdAt: now,
    updatedAt: now,
  };
  mockKnowledge.items = [article, ...mockKnowledge.items];
  return {
    id: uid(),
    role: 'assistant',
    content: `Собрал статью **«${article.title}»** и сохранил в базу знаний (метка AI).`,
    citations: [{ type: 'kb', id: article.id, label: article.title }],
    proposals: [],
    createdAt: now,
  };
}

export const assistantHandlers = [
  http.get('/api/assistant/status', () =>
    HttpResponse.json({
      enabled: mockAssistant.enabled,
      provider: mockAssistant.provider,
      model: mockAssistant.model,
      level: mockAssistant.level,
      permissions: mockAssistant.permissions,
    }),
  ),
  http.get('/api/settings/assistant', () =>
    HttpResponse.json({
      enabled: mockAssistant.enabled,
      provider: mockAssistant.provider,
      model: mockAssistant.model,
      level: mockAssistant.level,
      permissions: mockAssistant.permissions,
    }),
  ),
  http.put('/api/settings/assistant', async ({ request }) => {
    const body = (await request.json()) as {
      apiKey?: string;
      clearKey?: boolean;
      provider?: AssistantProvider;
      model?: string;
      level?: AssistantLevel;
      permissions?: Partial<AssistantPermissions>;
    };
    if (body.clearKey) mockAssistant.enabled = false;
    else if (body.apiKey) mockAssistant.enabled = true;
    if (body.provider) mockAssistant.provider = body.provider;
    if (typeof body.model === 'string') mockAssistant.model = body.model;
    if (body.level) mockAssistant.level = body.level;
    if (body.permissions) mockAssistant.permissions = { ...mockAssistant.permissions, ...body.permissions };
    return HttpResponse.json({
      enabled: mockAssistant.enabled,
      provider: mockAssistant.provider,
      model: mockAssistant.model,
      level: mockAssistant.level,
      permissions: mockAssistant.permissions,
    });
  }),
  http.get('/api/assistant/conversations', () => HttpResponse.json({ items: mockAssistant.conversations })),
  http.get('/api/assistant/conversations/:id', ({ params }) =>
    HttpResponse.json({ items: mockAssistant.messages[String(params.id)] ?? [] }),
  ),
  http.post('/api/assistant/chat', async ({ request }) => {
    if (!mockAssistant.enabled) return aProblem(409, 'AI-ассистент выключен: не задан ключ модели.');
    const body = (await request.json()) as {
      message: string;
      conversationId?: string;
      mode?: AssistantMode;
    };
    const convId = body.conversationId ?? uid();
    const existing = mockAssistant.conversations.find((c) => c.id === convId);
    if (!existing) {
      mockAssistant.conversations = [
        {
          id: convId,
          title: body.message.slice(0, 60),
          mode: body.mode ?? 'agent',
          createdAt: new Date().toISOString(),
        },
        ...mockAssistant.conversations,
      ];
    }
    // Режим закреплён за беседой: в существующей берём её режим, иначе — из запроса.
    const effMode: AssistantMode = existing ? existing.mode : (body.mode ?? 'agent');
    const userMsg: AssistantMessage = {
      id: uid(),
      role: 'user',
      content: body.message,
      citations: [],
      proposals: [],
      createdAt: new Date().toISOString(),
    };
    const reply = effMode === 'analysis' ? buildAnalysisReply() : buildReply();
    mockAssistant.messages[convId] = [...(mockAssistant.messages[convId] ?? []), userMsg, reply];
    return HttpResponse.json({ conversationId: convId, message: reply });
  }),
];
