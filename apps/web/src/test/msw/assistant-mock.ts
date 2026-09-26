import {
  ASSISTANT_PERMISSIONS_DEFAULT,
  type AssistantChange,
  type AssistantChangeProposal,
  type AssistantConversation,
  type AssistantLevel,
  type AssistantMessage,
  type AssistantPermissions,
  type AssistantProvider,
} from '@nodeservice/shared';
import { delay, HttpResponse, http } from 'msw';

import { pushAuditEntry } from './audit-mock';
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
  /** Сколько «думает» мок-сервер до ответа; в тестах ноль. */
  chatDelayMs: number;
  /** Изменения по предложению Джарвиса (J5) по id. */
  changes: Record<string, AssistantChange>;
  /** Карточки, которые при применении отвечают «состояние изменилось» или «ошибка»: так видны эти состояния. */
  applyOutcome: Record<string, 'stale' | 'failed'>;
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
  changes: {},
  applyOutcome: {},
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
  mockAssistant.chatDelayMs = 0;
  mockAssistant.changes = {};
  mockAssistant.applyOutcome = {};
}

function aProblem(status: number, detail: string) {
  return HttpResponse.json(
    { type: 'about:blank', title: detail, status, detail },
    { status, headers: { 'content-type': 'application/problem+json' } },
  );
}

type ChangeKind =
  | 'provider'
  | 'tags'
  | 'profile'
  | 'notes'
  | 'rename'
  | 'close'
  | 'pause'
  | 'cleanup'
  | 'policy'
  | 'expired';

/** Готовые изменения для демонстрации: те же тексты, что строит сервер (превью «было → станет»). */
function makeChange(kind: ChangeKind): AssistantChangeProposal {
  const server = mockServers.items[0]?.name ?? 'de-fra-01';
  const openIncident = mockIncidents.items.find((i) => i.status !== 'resolved');
  const now = new Date();
  const base = {
    id: uid(),
    conversationId: null,
    live: false,
    status: 'proposed' as const,
    note: null,
    decidedAt: null,
    decidedBy: null,
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 24 * 3_600_000).toISOString(),
  };
  const serverTarget = { type: 'server' as const, id: null, label: server };
  const defs: Record<ChangeKind, Omit<AssistantChange, keyof typeof base>> = {
    provider: {
      operation: 'server.provider',
      title: 'Сменить провайдера',
      level: 'T1',
      target: serverTarget,
      reason: `В панели у ${server} указан Hetzner, а вы сказали, что он у Aéza.`,
      rows: [{ label: 'Провайдер', before: 'Hetzner', after: 'Aéza' }],
      consequence: 'Провайдер только помечает сервер и на его работу не влияет.',
      reversible: true,
    },
    tags: {
      operation: 'server.tags',
      title: 'Изменить теги',
      level: 'T1',
      target: serverTarget,
      reason: 'Вы просили убрать «test» и пометить сервер как «vip».',
      rows: [
        {
          label: 'Теги',
          before: 'prod, de, test',
          after: 'prod, de, vip',
          added: ['vip'],
          removed: ['test'],
        },
      ],
      consequence: null,
      reversible: true,
    },
    profile: {
      operation: 'server.profile',
      title: 'Изменить профиль сервера',
      level: 'T1',
      target: serverTarget,
      reason: 'По снимку работают remnanode и nginx, слушаются порты 22 и 443: похоже на вход для клиентов.',
      rows: [
        { label: 'Функции сервера', before: '—', after: 'Вход', added: ['Вход'] },
        { label: 'Важность', before: 'Обычный', after: 'Критичный' },
        { label: 'Окно обслуживания', before: '—', after: 'ночью по Москве, 03:00–05:00' },
        {
          label: 'Ожидаемые контейнеры',
          before: '—',
          after: 'nginx, remnanode',
          added: ['nginx', 'remnanode'],
        },
        { label: 'Ожидаемые порты', before: '—', after: '22, 443', added: ['22', '443'] },
      ],
      consequence:
        'Для критичного сервера Джарвис будет называть последствия и окно обслуживания. Панель начнёт сверять ожидаемое со снимком состояния и показывать расхождения.',
      reversible: true,
    },
    notes: {
      operation: 'server.notes',
      title: 'Изменить заметку',
      level: 'T1',
      target: serverTarget,
      reason: 'Вы просили записать, кто оплачивает сервер.',
      rows: [
        { label: 'Заметка', before: '—', after: 'Оплачивает Lumax, аккаунт в личном кабинете хостера.' },
      ],
      consequence: null,
      reversible: true,
    },
    rename: {
      operation: 'server.rename',
      title: 'Переименовать сервер',
      level: 'T1',
      target: serverTarget,
      reason: 'Вы просили привести названия к единому виду.',
      rows: [{ label: 'Название', before: server, after: 'ru-entry-9' }],
      consequence:
        'Новое название появится в списке серверов и в инцидентах; в прежних записях Журнала останется старое.',
      reversible: true,
    },
    close: {
      operation: 'incident.resolve',
      title: 'Закрыть инцидент',
      level: 'T2',
      target: {
        type: 'incident',
        id: openIncident?.id ?? null,
        label: openIncident?.title ?? 'Нода остановлена',
      },
      reason: 'Нода снова работает: контейнер remnanode запущен, порт 443 слушается.',
      rows: [{ label: 'Статус', before: 'Открыт', after: 'Закрыт вручную' }],
      consequence: 'Если проблема осталась, панель заведёт новый инцидент. Закрытие кнопкой не отменяется.',
      reversible: false,
    },
    pause: {
      operation: 'autofix.pause',
      title: 'Поставить автопочинку на паузу',
      level: 'T1',
      target: { type: 'settings', id: 'incidents', label: 'Автопочинка' },
      reason: `Вы собираетесь обновлять ${server} и не хотите, чтобы панель сама перезапускала службы.`,
      rows: [{ label: 'Автопочинка', before: 'Работает', after: 'На паузе на 1 ч' }],
      consequence: 'Пока пауза, панель сама ничего не чинит; инциденты по-прежнему заводятся и видны.',
      reversible: true,
    },
    cleanup: {
      operation: 'maintenance.run',
      title: 'Очистить диск',
      level: 'T2',
      target: serverTarget,
      reason: 'Диск заполнен на 82 %, по проверке есть что убрать.',
      rows: [
        {
          label: 'Диск',
          before: 'Занято 82\u00A0%',
          after: 'Уберём ненужные пакеты, старые ядра, кеш apt, журнал сожмём до 200 МБ',
        },
      ],
      consequence:
        'Данные и настройки не трогаем. Старые ядра удаляются, поэтому очистку кнопкой не отменить.',
      reversible: false,
    },
    policy: {
      operation: 'autofix.policy',
      title: 'Изменить режим автопочинки',
      level: 'T2',
      target: { type: 'settings', id: 'incidents', label: 'Автопочинка: Диск заполняется' },
      reason: 'Очистка диска помогала в трёх случаях из трёх.',
      rows: [{ label: 'Режим для «Диск заполняется»', before: 'Спросить', after: 'Само' }],
      consequence:
        'Панель сама выполнит безопасные шаги (T1) при этом виде инцидента, без вашего нажатия. Шаги с подтверждением (T2) по-прежнему только по вашему решению.',
      reversible: true,
    },
    expired: {
      operation: 'server.provider',
      title: 'Сменить провайдера',
      level: 'T1',
      target: serverTarget,
      reason: 'Предложение было вчера.',
      rows: [{ label: 'Провайдер', before: 'Hetzner', after: 'Aéza' }],
      consequence: null,
      reversible: true,
    },
  };
  const change: AssistantChange = { ...base, ...defs[kind] };
  if (kind === 'notes') mockAssistant.applyOutcome[change.id] = 'stale';
  if (kind === 'rename') mockAssistant.applyOutcome[change.id] = 'failed';
  if (kind === 'expired') {
    change.status = 'expired';
    change.note =
      'Предложение не применили за 24 ч: состояние могло измениться. Попросите Джарвиса предложить заново.';
    change.createdAt = new Date(now.getTime() - 25 * 3_600_000).toISOString();
    change.expiresAt = new Date(now.getTime() - 3_600_000).toISOString();
  }
  mockAssistant.changes[change.id] = change;
  return {
    kind: 'change',
    changeId: change.id,
    operation: change.operation,
    title: change.title,
    level: change.level,
  };
}

/** Запись Журнала о решении по изменению, как её пишет сервер. */
function auditChange(change: AssistantChange, kind: 'applied' | 'reverted' | 'rejected' | 'failed'): void {
  pushAuditEntry({
    action: `assistant.change.${kind}`,
    category: 'assistant',
    result: kind === 'failed' ? 'failed' : 'ok',
    severity: kind === 'failed' ? 'warn' : 'info',
    targetType: change.target.type,
    targetId: change.target.id,
    targetDisplay: change.target.label,
    metadata: {
      changeId: change.id,
      operation: change.operation,
      title: change.title,
      reason: change.reason,
      rows: change.rows.map((r) => ({ label: r.label, before: r.before, after: r.after })),
      ...(change.note ? { note: change.note } : {}),
    },
  });
}

const CHANGE_TRIGGERS: Array<[RegExp, ChangeKind[]]> = [
  [/предложи изменения/i, ['provider', 'tags', 'profile']],
  [/провайдер/i, ['provider']],
  [/тег/i, ['tags']],
  [/профил/i, ['profile']],
  [/заметк/i, ['notes']],
  [/переименуй/i, ['rename']],
  [/закр[ойы]\S* инцидент/i, ['close']],
  [/пауз/i, ['pause']],
  [/очист/i, ['cleanup']],
  [/режим автопочинки/i, ['policy']],
  [/просроч/i, ['expired']],
];

/** Демо-ответ Джарвиса: цитаты (база знаний + инцидент) и предложение автопочинки. */
function buildReply(text = ''): AssistantMessage {
  const kinds = CHANGE_TRIGGERS.find(([re]) => re.test(text))?.[1];
  if (kinds && mockAssistant.permissions.changes)
    return {
      id: uid(),
      role: 'assistant',
      content:
        kinds.length > 1
          ? 'Предложил три изменения. Пока вы не нажмёте «Применить» на карточке, ничего не изменится.'
          : 'Предложил изменение. Пока вы не нажмёте «Применить» на карточке, ничего не изменится.',
      citations: [],
      proposals: kinds.map(makeChange),
      reachability: [],
      createdAt: new Date().toISOString(),
    };
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

const changeOr404 = (id: unknown) => mockAssistant.changes[String(id)] ?? null;

/** Итог решения человека по изменению: те же переходы и тексты, что у сервера. */
function decide(change: AssistantChange, action: 'apply' | 'reject' | 'revert') {
  const at = new Date().toISOString();
  if (action === 'reject') {
    if (change.status === 'rejected') return HttpResponse.json(change);
    if (change.status !== 'proposed')
      return aProblem(409, `Предложение уже в состоянии «${change.status}»: отклонить его нельзя.`);
    Object.assign(change, { status: 'rejected', decidedAt: at, decidedBy: 'admin' });
    auditChange(change, 'rejected');
    return HttpResponse.json(change);
  }
  if (action === 'revert') {
    if (change.status === 'reverted') return HttpResponse.json(change);
    if (change.status !== 'applied' || !change.reversible)
      return aProblem(
        409,
        change.reversible
          ? 'Отменить можно только применённое изменение.'
          : 'Это изменение кнопкой не отменяется.',
      );
    Object.assign(change, {
      status: 'reverted',
      decidedAt: at,
      decidedBy: 'admin',
      note: `Возвращено прежнее значение: ${change.rows.map((r) => `${r.label}: ${r.before}`).join('; ')}.`,
    });
    auditChange(change, 'reverted');
    return HttpResponse.json(change);
  }
  if (change.status === 'applied' || change.status === 'expired') return HttpResponse.json(change);
  if (change.status !== 'proposed')
    return aProblem(409, `Это предложение уже в состоянии «${change.status}»: применить его нельзя.`);
  const outcome = mockAssistant.applyOutcome[change.id];
  if (outcome === 'stale')
    Object.assign(change, {
      status: 'stale',
      note: 'Состояние изменилось после предложения, ничего не применено. Сейчас: Заметка: Проверка связи. Попросите Джарвиса предложить заново.',
    });
  else if (outcome === 'failed')
    Object.assign(change, { status: 'failed', note: 'Название «ru-entry-9» уже занято другим сервером.' });
  else if (change.operation === 'maintenance.run')
    Object.assign(change, {
      status: 'applied',
      live: true,
      decidedAt: at,
      decidedBy: 'admin',
      note: `Запущено: ${change.title}. Идёт: Подключение по SSH.`,
    });
  else
    Object.assign(change, {
      status: 'applied',
      decidedAt: at,
      decidedBy: 'admin',
      note: `Проверено: ${change.rows.map((r) => `${r.label}: ${r.after}`).join('; ')}.`,
    });
  auditChange(change, outcome ? 'failed' : 'applied');
  return HttpResponse.json(change);
}

export const assistantHandlers = [
  http.get('/api/assistant/changes/summary', () => {
    const all = Object.values(mockAssistant.changes);
    const n = (s: string) => all.filter((c) => c.status === s).length;
    return HttpResponse.json({
      days: 7,
      applied: n('applied'),
      reverted: n('reverted'),
      rejected: n('rejected'),
      pending: n('proposed'),
    });
  }),
  http.get('/api/assistant/changes/:id', ({ params }) => {
    const change = changeOr404(params.id);
    if (!change) return aProblem(404, 'Изменение не найдено.');
    // Фоновое обслуживание в моке заканчивается через несколько секунд после запуска.
    if (change.live && change.decidedAt && Date.now() - Date.parse(change.decidedAt) > 6_000)
      Object.assign(change, {
        live: false,
        note: `${change.title}: готово за 14 с. Подробности: вкладка «Обслуживание» сервера.`,
      });
    return HttpResponse.json(change);
  }),
  http.post('/api/assistant/changes/:id/:action', ({ params }) => {
    const change = changeOr404(params.id);
    if (!change) return aProblem(404, 'Изменение не найдено.');
    const action = String(params.action);
    if (action !== 'apply' && action !== 'reject' && action !== 'revert')
      return aProblem(404, 'Такого действия нет.');
    return decide(change, action);
  }),
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
