import { z } from 'zod';

import { changeOperationSchema } from './assistant-changes.js';
import { ACTION_LEVELS } from './incidents.js';
import { reachabilityResultSchema } from './reachability.js';

/**
 * Джарвис (этап 9): чат со знанием состояния парка и базы знаний.
 * Джарвис НИКОГДА не выполняет действия сам — только предлагает (proposal),
 * а выполняет — администратор через тот же step-up/подтверждение, что и вручную.
 */

/** Провайдеры LLM. Пока один — zveno.ai (OpenAI-совместимый шлюз); список будем дополнять. */
export const ASSISTANT_PROVIDERS = ['zveno'] as const;
export type AssistantProvider = (typeof ASSISTANT_PROVIDERS)[number];

export const ASSISTANT_PROVIDER_LABELS: Record<AssistantProvider, string> = {
  zveno: 'zveno.ai',
};

export const ASSISTANT_MODEL_MAX = 80;

/**
 * Верхний предел сообщения Джарвису. Режима «Анализ» больше нет: Джарвис сам понимает, что ему прислали
 * (вопрос, статью, словарь терминов, вывод команды), поэтому в чат можно вставить целый мануал.
 */
export const ASSISTANT_MESSAGE_MAX = 100_000;

/**
 * Подробность ответов Джарвиса. Ключи остались прежними (novice, intermediate, pro), поэтому старые
 * настройки читаются; для человека это «Подробно», «Обычно» и «Кратко». Подробнее значит длиннее ответы
 * и больше токенов у провайдера нейросети.
 */
export const ASSISTANT_LEVELS = ['novice', 'intermediate', 'pro'] as const;
export type AssistantLevel = (typeof ASSISTANT_LEVELS)[number];
export const ASSISTANT_LEVEL_LABELS: Record<AssistantLevel, string> = {
  pro: 'Кратко',
  intermediate: 'Обычно',
  novice: 'Подробно',
};
export const ASSISTANT_LEVEL_HINTS: Record<AssistantLevel, string> = {
  novice:
    'Подробно и простыми словами, с расшифровкой терминов и аббревиатур. Ответы длиннее, токенов уходит больше.',
  intermediate: 'По делу, но с пояснением неочевидных терминов и шагов. Токенов уходит средне.',
  pro: 'Коротко, терминами и аббревиатурами, без разжёвывания базового. Токенов уходит меньше.',
};
export const ASSISTANT_LEVEL_TOKENS: Record<AssistantLevel, string> = {
  pro: 'Токенов: меньше',
  intermediate: 'Токенов: средне',
  novice: 'Токенов: больше',
};
export const ASSISTANT_LEVEL_DEFAULT: AssistantLevel = 'intermediate';

/** Разрешения Джарвиса: что ему можно в вашей системе. Настройки он только читает, действия только предлагает. */
export const ASSISTANT_PERMISSION_KEYS = [
  'kbWrite',
  'kbReview',
  'reach',
  'processes',
  'inspect',
  'nodeLogs',
  'serviceLogs',
  'terminalHints',
  'analysis',
  'autoAnalysis',
  'proposals',
  'changes',
] as const;
export type AssistantPermission = (typeof ASSISTANT_PERMISSION_KEYS)[number];
export const ASSISTANT_PERMISSION_LABELS: Record<AssistantPermission, string> = {
  kbWrite: 'Создание и правка статей',
  kbReview: 'Еженедельная ревизия',
  reach: 'Проверка доступности снаружи',
  processes: 'Осмотр процессов',
  inspect: 'Осмотр служб и системы',
  nodeLogs: 'Логи ноды',
  serviceLogs: 'Журналы служб',
  terminalHints: 'Подсказки в терминале',
  analysis: 'Разбор по кнопке',
  autoAnalysis: 'Автоматический разбор',
  proposals: 'Карточки предложений',
  changes: 'Изменения по подтверждению',
};
export const ASSISTANT_PERMISSION_HINTS: Record<AssistantPermission, string> = {
  kbWrite: 'Джарвис может сам писать статьи в базу знаний, с меткой «AI».',
  kbReview: 'Раз в неделю наводит порядок: чистит артефакты, дополняет, предлагает правки.',
  reach: 'С двух-трёх других серверов парка проверяет порт и DNS вашего сервера.',
  processes: 'Имена и проценты CPU и памяти, без командных строк.',
  inspect:
    'Состояние контейнеров и их перезапуски, слушающие порты, диск, события ядра (нехватка памяти, ошибки диска), срок действия сертификата. Только состояние и имена, без текста журналов.',
  nodeLogs:
    'Последние строки журнала контейнера ноды. В логах бывают адреса пользователей: они маскируются, но остальной текст уходит провайдеру.',
  serviceLogs:
    'Последние строки журналов агента, SSH, Docker, других контейнеров и ошибок системы за выбранный период. В журналах бывают адреса пользователей: они маскируются, но остальной текст уходит провайдеру.',
  terminalHints: 'Разбор вывода терминала, который вы сами показали кнопкой. Секреты маскируются.',
  analysis: 'Кнопка «Разобрать инцидент» в деле инцидента.',
  autoAnalysis:
    'Сам разбирает предупреждения и критичные инциденты спустя минуту после открытия. Тратит токены, не больше пяти разборов в час.',
  proposals: 'Предлагает шаг из цепочки инцидента карточкой. Запускаете шаг вы.',
  changes:
    'Предлагает изменить сервер (провайдер, теги, заметку, название, слежение за нодой, профиль), закрыть инцидент или поставить автопочинку на паузу: карточкой с «было → станет». Применяете вы; применённое записывается в Журнал и по возможности отменяется кнопкой.',
};

/** Что делает возможность: метки риска рядом с переключателем. */
export const ASSISTANT_RISKS = ['reads', 'writes', 'servers', 'provider', 'confirm'] as const;
export type AssistantRisk = (typeof ASSISTANT_RISKS)[number];
export const ASSISTANT_RISK_LABELS: Record<AssistantRisk, string> = {
  reads: 'Читает',
  writes: 'Пишет в базу знаний',
  servers: 'Ходит на серверы',
  provider: 'Данные уходят провайдеру',
  confirm: 'Только с вашего подтверждения',
};
export const ASSISTANT_PERMISSION_RISKS: Record<AssistantPermission, AssistantRisk[]> = {
  kbWrite: ['writes'],
  kbReview: ['writes'],
  reach: ['servers'],
  processes: ['servers', 'provider'],
  inspect: ['servers', 'provider'],
  nodeLogs: ['servers', 'provider'],
  serviceLogs: ['servers', 'provider'],
  terminalHints: ['provider'],
  analysis: ['reads', 'provider'],
  autoAnalysis: ['reads', 'provider'],
  proposals: ['confirm'],
  changes: ['confirm'],
};

/** Группы разрешений для экрана настроек. */
export const ASSISTANT_PERMISSION_GROUPS: ReadonlyArray<{
  key: string;
  title: string;
  note?: string;
  keys: readonly AssistantPermission[];
}> = [
  { key: 'kb', title: 'База знаний', keys: ['kbWrite', 'kbReview'] },
  {
    key: 'servers',
    title: 'Серверы, только чтение',
    note: 'по SSH от имени панели',
    keys: ['reach', 'processes', 'inspect', 'nodeLogs', 'serviceLogs', 'terminalHints'],
  },
  { key: 'incidents', title: 'Инциденты', keys: ['analysis', 'autoAnalysis', 'proposals'] },
  { key: 'changes', title: 'Изменения', note: 'только с вашего подтверждения', keys: ['changes'] },
];

export type AssistantPermissions = Record<AssistantPermission, boolean>;
export const ASSISTANT_PERMISSIONS_DEFAULT: AssistantPermissions = {
  kbWrite: true,
  kbReview: true,
  reach: true,
  processes: true,
  inspect: true,
  nodeLogs: false,
  serviceLogs: false,
  terminalHints: true,
  analysis: true,
  autoAnalysis: false,
  proposals: true,
  changes: true,
};

/** Пресеты одним нажатием: «Осторожный», «Обычный» и «Максимальный автоматизм». */
export const ASSISTANT_PRESET_KEYS = ['careful', 'normal', 'max'] as const;
export type AssistantPreset = (typeof ASSISTANT_PRESET_KEYS)[number];
export const ASSISTANT_PRESETS: Record<
  AssistantPreset,
  { label: string; description: string; permissions: AssistantPermissions }
> = {
  careful: {
    label: 'Осторожный',
    description:
      'Только чтение и подсказки. Статьи в базу знаний не пишет, на серверы сам не ходит, разбор только по кнопке.',
    permissions: {
      kbWrite: false,
      kbReview: false,
      reach: false,
      processes: false,
      inspect: false,
      nodeLogs: false,
      serviceLogs: false,
      terminalHints: true,
      analysis: true,
      autoAnalysis: false,
      proposals: true,
      changes: false,
    },
  },
  normal: {
    label: 'Обычный',
    description:
      'Чтение, статьи, проверки доступности, процессов и состояния служб (контейнеры, порты, диск, ядро, сертификат), разбор по кнопке.',
    permissions: { ...ASSISTANT_PERMISSIONS_DEFAULT },
  },
  max: {
    label: 'Максимальный автоматизм',
    description:
      'Всё из «Обычного» плюс автоматический разбор инцидентов, логи ноды и журналы служб. Изменения серверов по-прежнему только с вашего подтверждения.',
    permissions: {
      kbWrite: true,
      kbReview: true,
      reach: true,
      processes: true,
      inspect: true,
      nodeLogs: true,
      serviceLogs: true,
      terminalHints: true,
      analysis: true,
      autoAnalysis: true,
      proposals: true,
      changes: true,
    },
  },
};

/** Какой пресет совпадает с текущими разрешениями; null — настроено вручную. */
export function matchAssistantPreset(p: AssistantPermissions): AssistantPreset | null {
  return (
    ASSISTANT_PRESET_KEYS.find((k) =>
      ASSISTANT_PERMISSION_KEYS.every((perm) => ASSISTANT_PRESETS[k].permissions[perm] === p[perm]),
    ) ?? null
  );
}

const assistantPermissionsSchema = z.object(
  Object.fromEntries(ASSISTANT_PERMISSION_KEYS.map((k) => [k, z.boolean()])) as Record<
    AssistantPermission,
    z.ZodBoolean
  >,
);

export const assistantStatusSchema = z.object({
  /** Ключ и модель заданы — Джарвис работает. */
  enabled: z.boolean(),
  provider: z.enum(ASSISTANT_PROVIDERS),
  /** Название модели вводит администратор (например «anthropic/claude-sonnet-4-5»). */
  model: z.string(),
  level: z.enum(ASSISTANT_LEVELS),
  permissions: assistantPermissionsSchema,
});
export type AssistantStatus = z.infer<typeof assistantStatusSchema>;

/** Настройки Джарвиса (Настройки → Джарвис): ключ приходит только на запись. */
export const assistantSettingsUpdateSchema = z.object({
  provider: z.enum(ASSISTANT_PROVIDERS).optional(),
  apiKey: z.string().trim().min(8).max(400).optional(),
  /** true — стереть ключ (выключить Джарвиса). */
  clearKey: z.boolean().optional(),
  model: z.string().trim().max(ASSISTANT_MODEL_MAX).optional(),
  level: z.enum(ASSISTANT_LEVELS).optional(),
  permissions: assistantPermissionsSchema.partial().optional(),
});
export type AssistantSettingsUpdate = z.infer<typeof assistantSettingsUpdateSchema>;

/** Ссылка-цитата на источник ответа. */
export const assistantCitationSchema = z.object({
  type: z.enum(['server', 'incident', 'audit', 'kb', 'metric']),
  id: z.string(),
  label: z.string(),
});
export type AssistantCitation = z.infer<typeof assistantCitationSchema>;

/** Предложение шага автопочинки для инцидента — выполняется только после подтверждения администратором. */
export const assistantAutofixProposalSchema = z.object({
  kind: z.literal('autofix'),
  incidentId: z.uuid(),
  preset: z.string(),
  title: z.string(),
  description: z.string(),
  /** Уровень действия из реестра. Старые предложения без него: интерфейс берёт уровень из реестра сам. */
  level: z.enum(ACTION_LEVELS).optional(),
  /** Почему Джарвис предлагает именно этот шаг (его слова, без последствий из реестра). */
  reason: z.string().optional(),
});
export type AssistantAutofixProposal = z.infer<typeof assistantAutofixProposalSchema>;

/** Предложение изменения (J5): карточка берёт подробности и состояние по `changeId`. */
export const assistantChangeProposalSchema = z.object({
  kind: z.literal('change'),
  changeId: z.uuid(),
  operation: changeOperationSchema,
  title: z.string(),
  level: z.enum(ACTION_LEVELS),
});
export type AssistantChangeProposal = z.infer<typeof assistantChangeProposalSchema>;

export const assistantProposalSchema = z.discriminatedUnion('kind', [
  assistantAutofixProposalSchema,
  assistantChangeProposalSchema,
]);
export type AssistantProposal = z.infer<typeof assistantProposalSchema>;

export const assistantMessageSchema = z.object({
  id: z.uuid(),
  role: z.enum(['user', 'assistant']),
  content: z.string(),
  citations: z.array(assistantCitationSchema).default([]),
  proposals: z.array(assistantProposalSchema).default([]),
  /** Проверки доступности, сделанные при ответе (показываются матрицей под ответом). */
  reachability: z.array(reachabilityResultSchema).default([]),
  createdAt: z.iso.datetime(),
});
export type AssistantMessage = z.infer<typeof assistantMessageSchema>;

export const assistantChatRequestSchema = z
  .object({
    message: z.string().trim().min(1),
    conversationId: z.uuid().optional(),
  })
  .superRefine((val, ctx) => {
    if (val.message.length > ASSISTANT_MESSAGE_MAX) {
      ctx.addIssue({
        code: 'custom',
        path: ['message'],
        message: `Слишком длинный текст: ${val.message.length} из ${ASSISTANT_MESSAGE_MAX} знаков. Разбейте его на части и отправьте по очереди.`,
      });
    }
  });
export type AssistantChatRequest = z.infer<typeof assistantChatRequestSchema>;

export const assistantChatResponseSchema = z.object({
  conversationId: z.uuid(),
  /** Последнее сообщение хода (итог). */
  message: assistantMessageSchema,
  /** Все сообщения хода по порядку: реплики по ходу работы и итог; их может быть несколько. */
  messages: z.array(assistantMessageSchema).min(1),
});
export type AssistantChatResponse = z.infer<typeof assistantChatResponseSchema>;

export const assistantConversationSchema = z.object({
  id: z.uuid(),
  title: z.string(),
  createdAt: z.iso.datetime(),
});
export type AssistantConversation = z.infer<typeof assistantConversationSchema>;

export const assistantConversationsResponseSchema = z.object({
  items: z.array(assistantConversationSchema),
});
export const assistantHistoryResponseSchema = z.object({ items: z.array(assistantMessageSchema) });

/** Подсказки-чипы над полем ввода. */
export const ASSISTANT_SUGGESTIONS = [
  'Что сейчас требует внимания?',
  'Почему инцидент открыт?',
  'Как поднять лимит conntrack?',
  'Какие серверы под нагрузкой?',
  'Как установить агента на сервер?',
  'Что было в Журнале за час?',
] as const;

/** Подсказка к терминалу (R4.6): вывод терминала → объяснение и команды, которые можно вставить. */
export const TERMINAL_HINT_TEXT_MAX = 12_000;
export const terminalHintRequestSchema = z.object({
  /** Последние строки терминала; секреты маскируются на сервере до отправки модели. */
  text: z.string().max(TERMINAL_HINT_TEXT_MAX),
  question: z.string().trim().max(500).optional(),
});
export type TerminalHintRequest = z.infer<typeof terminalHintRequestSchema>;

export const TERMINAL_COMMAND_RISKS = ['read', 'change'] as const;
export const terminalHintResponseSchema = z.object({
  title: z.string(),
  explanation: z.string(),
  commands: z.array(
    z.object({
      command: z.string(),
      note: z.string(),
      /** read — только читает; change — меняет систему, вставить можно, но осторожно. */
      risk: z.enum(TERMINAL_COMMAND_RISKS),
    }),
  ),
  /** Сколько фрагментов замаскировано перед отправкой: ключи, пароли, токены, адреса. */
  masked: z.number().int().min(0),
});
export type TerminalHintResponse = z.infer<typeof terminalHintResponseSchema>;
