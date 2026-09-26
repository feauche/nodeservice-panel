import {
  ASSISTANT_PERMISSIONS_DEFAULT,
  type AssistantConversation,
  type AssistantLevel,
  type AssistantMessage,
  type AssistantPermissions,
  type AssistantProvider,
} from '@nodeservice/shared';
import { HttpResponse, http } from 'msw';

import { mockIncidents } from './incidents-mock';
import { sampleReach } from './reach-sample';
import { mockServers } from './servers-mock';

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
  permissions: { ...ASSISTANT_PERMISSIONS_DEFAULT },
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
  mockAssistant.permissions = { ...ASSISTANT_PERMISSIONS_DEFAULT };
  mockAssistant.conversations = [];
  mockAssistant.messages = {};
}

function aProblem(status: number, detail: string) {
  return HttpResponse.json(
    { type: 'about:blank', title: detail, status, detail },
    { status, headers: { 'content-type': 'application/problem+json' } },
  );
}

/** Демо-ответ Джарвиса: цитаты (база знаний + инцидент) и предложение автопочинки. */
function buildReply(text = ''): AssistantMessage {
  if (/доступ|снаружи/i.test(text))
    return {
      id: uid(),
      role: 'assistant',
      content:
        'Порт SSH открыт со всех проверяющих, а порт 443 закрыт. Похоже, сервис не слушает 443 или его закрывает фильтр.',
      citations: [],
      proposals: [],
      reachability: [sampleReach('de-fra-01', 'closed443')],
      createdAt: new Date().toISOString(),
    };
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
      level: 'T2',
      reason: 'CPU держится выше порога, а по базе знаний помогает перезапуск.',
    });
  }
  return {
    id: uid(),
    role: 'assistant',
    content:
      'Сейчас на **de-fra-01** высокая нагрузка на CPU. По базе знаний помогает `перезапуск Xray`. Могу предложить безопасное действие: вы подтвердите, и оно запустится.',
    citations,
    proposals,
    reachability: [],
    createdAt: new Date().toISOString(),
  };
}

/** Ответ в двух сообщениях: «сейчас посмотрю» и итог с именами серверов и одной ссылкой-источником. */
function buildFleetReplies(): AssistantMessage[] {
  const now = new Date().toISOString();
  const fra = mockServers.items.find((x) => x.name === 'de-fra-01');
  return [
    {
      id: uid(),
      role: 'assistant',
      content: 'Смотрю историю инцидентов за всё время.',
      citations: [],
      proposals: [],
      reachability: [],
      createdAt: now,
    },
    {
      id: uid(),
      role: 'assistant',
      content:
        '**Инциденты по серверам за всё время:**\n\n- de-fra-01 — 4 инцидента, все закрыты\n- nl-ams-02 — 2 инцидента, все закрыты\n\nБольше всего сбоев на первом.',
      citations: fra ? [{ type: 'server', id: fra.id, label: fra.name }] : [],
      proposals: [],
      reachability: [],
      createdAt: now,
    },
  ];
}

export const assistantHandlers = [
  http.post('/api/servers/:id/terminal/hint', async ({ request }) => {
    if (!mockAssistant.enabled)
      return aProblem(409, 'Джарвис выключен: задайте провайдера, ключ и модель в «Настройки → Джарвис».');
    const body = (await request.json().catch(() => ({}))) as { text?: string; question?: string };
    const text = (body.text ?? '').trim();
    if (!text) return aProblem(400, 'В терминале пока нет вывода: подсказывать нечего.');
    const masked = (text.match(/password|token|secret|\b\d{1,3}(?:\.\d{1,3}){3}\b/gi) ?? []).length;
    const conntrack = /conntrack/i.test(text);
    return HttpResponse.json({
      title: conntrack ? 'Упёрся conntrack' : 'Вывод выглядит обычно',
      explanation: conntrack
        ? 'В ядре переполнена таблица соединений, поэтому новые соединения отбрасываются. Сервис жив, но часть пользователей не подключается.'
        : `Ничего тревожного в последних строках не видно.${body.question ? ` Вы спросили: «${body.question}».` : ''}`,
      commands: conntrack
        ? [
            {
              command: 'cat /proc/sys/net/netfilter/nf_conntrack_max',
              note: 'Какой сейчас предел',
              risk: 'read',
            },
            {
              command: 'sysctl net.netfilter.nf_conntrack_count',
              note: 'Сколько записей занято',
              risk: 'read',
            },
            {
              command: 'sysctl -w net.netfilter.nf_conntrack_max=1048576',
              note: 'Поднять предел, учтите объём памяти',
              risk: 'change',
            },
          ]
        : [{ command: 'uptime', note: 'Посмотреть нагрузку', risk: 'read' }],
      masked,
    });
  }),
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
    if (!mockAssistant.enabled) return aProblem(409, 'Джарвис выключен: не задан ключ модели.');
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
      createdAt: new Date().toISOString(),
    };
    const replies = /по каким серверам/i.test(body.message)
      ? buildFleetReplies()
      : [buildReply(body.message)];
    const reply = replies[replies.length - 1] as AssistantMessage;
    mockAssistant.messages[convId] = [...(mockAssistant.messages[convId] ?? []), userMsg, ...replies];
    return HttpResponse.json({ conversationId: convId, message: reply, messages: replies });
  }),
];
