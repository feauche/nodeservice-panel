import {
  ASSISTANT_PERMISSIONS_DEFAULT,
  type AssistantConversation,
  type AssistantLevel,
  type AssistantMessage,
  type AssistantPermissions,
  type AssistantProvider,
} from '@nodeservice/shared';
import { delay, HttpResponse, http } from 'msw';

import { mockIncidents } from './incidents-mock';

interface AssistantMock {
  enabled: boolean;
  provider: AssistantProvider;
  model: string;
  level: AssistantLevel;
  permissions: AssistantPermissions;
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
  permissions: { ...ASSISTANT_PERMISSIONS_DEFAULT },
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
  mockAssistant.permissions = { ...ASSISTANT_PERMISSIONS_DEFAULT };
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
function buildReply(text = ''): AssistantMessage {
  if (/доступ|снаружи/i.test(text))
    return {
      id: uid(),
      role: 'assistant',
      content:
        'По последней проверке Check-Host порт 443 не отвечает из России. Запустите проверку порта в окне ноды, чтобы увидеть свежий результат.',
      citations: [],
      proposals: [],
      reachability: [],
      activity: [],
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
    proposals: [],
    reachability: [],
    activity: [],
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
      proposals: [],
      reachability: [],
      activity: [],
      createdAt: now,
    },
    {
      id: uid(),
      role: 'assistant',
      content:
        '**События по серверам за всё время:**\n\n- de-fra-01 — 4 события, все закрыты\n- nl-ams-02 — 2 события, все закрыты\n\nБольше всего сбоев на первом.',
      citations: [{ type: 'server', id: MOCK_OLD_SERVER.id, label: MOCK_OLD_SERVER.name }],
      proposals: [],
      reachability: [],
      activity: [],
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
    if (!mockAssistant.enabled) return aProblem(409, 'Ассистент выключен: не задан ключ модели.');
    const body = (await request.json()) as {
      message: string;
      conversationId?: string;
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
    const userMsg: AssistantMessage = {
      id: uid(),
      role: 'user',
      content: body.message,
      citations: [],
      proposals: [],
      reachability: [],
      activity: [],
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
