import type {
  AssistantConversation,
  AssistantLevel,
  AssistantMessage,
  AssistantProvider,
} from '@nodeservice/shared';
import { delay, HttpResponse, http } from 'msw';

import { mockIncidents } from './incidents-mock';

interface AssistantMock {
  enabled: boolean;
  provider: AssistantProvider;
  model: string;
  level: AssistantLevel;
  conversations: AssistantConversation[];
  messages: Record<string, AssistantMessage[]>;
  /** Сколько «думает» мок-сервер до ответа; в тестах ноль. */
  chatDelayMs: number;
}
export const mockAssistant: AssistantMock = {
  enabled: false,
  provider: 'zveno',
  model: 'anthropic/claude-sonnet-4-5',
  level: 'intermediate',
  conversations: [],
  messages: {},
  chatDelayMs: 0,
};

/** Старый сервер из прежних ответов: такие цитаты остались только в истории бесед. */
export const MOCK_OLD_SERVER = { id: '0192f100-0000-7000-8000-000000000001', name: 'de-fra-01' } as const;

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
  mockAssistant.conversations = [];
  mockAssistant.messages = {};
  mockAssistant.chatDelayMs = 0;
}

function aProblem(status: number, detail: string) {
  return HttpResponse.json(
    { type: 'about:blank', title: detail, status, detail },
    { status, headers: { 'content-type': 'application/problem+json' } },
  );
}

/** Демо-ответ Ассистента: текст и цитаты (база знаний + событие). Действий Ассистент не предлагает. */
/** Нода из советов демо-ответа: в тестах её подставляют в список нод. */
export const MOCK_ADVICE_NODE = { uuid: '0192f200-0000-7000-8000-000000000002', name: 'nl-ams-02' } as const;

function buildReply(text = ''): AssistantMessage {
  if (/доступ|снаружи|проверить/i.test(text))
    return {
      id: uid(),
      role: 'assistant',
      content:
        'Remnawave не получает ответа от ноды три проверки подряд. Похоже на сеть или блокировку — сначала проверьте порт снаружи.',
      citations: [],
      advice: [
        {
          check: 'tcp',
          nodeUuid: MOCK_ADVICE_NODE.uuid,
          nodeName: MOCK_ADVICE_NODE.name,
          address: '45.12.8.20:443',
          reason: 'Remnawave не получает ответа от ноды три проверки подряд.',
        },
      ],
      createdAt: new Date().toISOString(),
    };
  const cpu = mockIncidents.items.find((i) => i.kind === 'cpu_high' && i.status !== 'resolved');
  const kb = { type: 'kb' as const, id: '0192e000-0000-7000-8000-000000000001', label: 'Лимит conntrack' };
  const citations: AssistantMessage['citations'] = [kb];
  if (cpu) citations.push({ type: 'incident', id: cpu.id, label: cpu.title });
  return {
    id: uid(),
    role: 'assistant',
    content:
      'Сейчас на **de-fra-01** высокая нагрузка на CPU. По базе знаний помогает `перезапуск Xray` — его выполняете вы сами.',
    citations,
    createdAt: new Date().toISOString(),
  };
}

/** Ответ в двух сообщениях: «сейчас посмотрю» и итог с именами серверов и цитатой старого сервера. */
function buildFleetReplies(): AssistantMessage[] {
  const now = new Date().toISOString();
  return [
    {
      id: uid(),
      role: 'assistant',
      content: 'Смотрю историю событий за всё время.',
      citations: [],
      createdAt: now,
    },
    {
      id: uid(),
      role: 'assistant',
      content:
        '**События по серверам за всё время:**\n\n- de-fra-01 — 4 события, все закрыты\n- nl-ams-02 — 2 события, все закрыты\n\nБольше всего сбоев на первом.',
      citations: [{ type: 'server', id: MOCK_OLD_SERVER.id, label: MOCK_OLD_SERVER.name }],
      createdAt: now,
    },
  ];
}

export const assistantHandlers = [
  http.get('/api/assistant/status', () =>
    HttpResponse.json({
      enabled: mockAssistant.enabled,
      provider: mockAssistant.provider,
      model: mockAssistant.model,
      level: mockAssistant.level,
    }),
  ),
  http.get('/api/settings/assistant', () =>
    HttpResponse.json({
      enabled: mockAssistant.enabled,
      provider: mockAssistant.provider,
      model: mockAssistant.model,
      level: mockAssistant.level,
    }),
  ),
  http.put('/api/settings/assistant', async ({ request }) => {
    const body = (await request.json()) as {
      apiKey?: string;
      clearKey?: boolean;
      provider?: AssistantProvider;
      model?: string;
      level?: AssistantLevel;
    };
    if (body.clearKey) mockAssistant.enabled = false;
    else if (body.apiKey) mockAssistant.enabled = true;
    if (body.provider) mockAssistant.provider = body.provider;
    if (typeof body.model === 'string') mockAssistant.model = body.model;
    if (body.level) mockAssistant.level = body.level;
    return HttpResponse.json({
      enabled: mockAssistant.enabled,
      provider: mockAssistant.provider,
      model: mockAssistant.model,
      level: mockAssistant.level,
    });
  }),
  http.get('/api/assistant/conversations', () => HttpResponse.json({ items: mockAssistant.conversations })),
  http.get('/api/assistant/conversations/:id', ({ params }) =>
    HttpResponse.json({ items: mockAssistant.messages[String(params.id)] ?? [] }),
  ),
  http.post('/api/assistant/chat', async ({ request }) => {
    if (!mockAssistant.enabled) return aProblem(409, 'Ассистент выключен: не задан ключ модели.');
    const body = (await request.json()) as {
      message: string;
      conversationId?: string;
      context?: { kind: 'incident' | 'node'; id: string };
    };
    const convId = body.conversationId ?? uid();
    const existing = mockAssistant.conversations.find((c) => c.id === convId);
    if (!existing) {
      mockAssistant.conversations = [
        {
          id: convId,
          title: body.message.slice(0, 60),
          createdAt: new Date().toISOString(),
        },
        ...mockAssistant.conversations,
      ];
    }
    // Как на сервере: у вопроса со страницы события или из окна ноды — метка, откуда он задан.
    const inc =
      body.context?.kind === 'incident'
        ? mockIncidents.items.find((i) => i.id === body.context?.id)
        : undefined;
    const context = body.context
      ? {
          ...body.context,
          label: inc
            ? `Событие: ${inc.title}`
            : `${body.context.kind === 'node' ? 'Нода' : 'Событие'}: ${body.context.id}`,
        }
      : null;
    const userMsg: AssistantMessage = {
      id: uid(),
      role: 'user',
      content: body.message,
      citations: [],
      context,
      createdAt: new Date().toISOString(),
    };
    // Как на сервере: сообщение администратора сохраняется сразу, ответ приходит после раздумий.
    mockAssistant.messages[convId] = [...(mockAssistant.messages[convId] ?? []), userMsg];
    if (mockAssistant.chatDelayMs > 0) await delay(mockAssistant.chatDelayMs);
    const replies = /по каким серверам/i.test(body.message)
      ? buildFleetReplies()
      : [buildReply(body.message)];
    const reply = replies[replies.length - 1] as AssistantMessage;
    mockAssistant.messages[convId] = [...(mockAssistant.messages[convId] ?? []), ...replies];
    return HttpResponse.json({ conversationId: convId, message: reply, messages: replies });
  }),
];
