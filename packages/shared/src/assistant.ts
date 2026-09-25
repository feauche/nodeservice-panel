import { z } from 'zod';

import { ACTION_LEVELS } from './incidents.js';
import { reachabilityResultSchema } from './reachability.js';

/**
 * AI-ассистент (этап 9): чат со знанием состояния парка и базы знаний.
 * Ассистент НИКОГДА не выполняет действия сам — только предлагает (proposal),
 * а выполняет — администратор через тот же step-up/подтверждение, что и вручную.
 */

/** Провайдеры LLM. Пока один — zveno.ai (OpenAI-совместимый шлюз); список будем дополнять. */
export const ASSISTANT_PROVIDERS = ['zveno'] as const;
export type AssistantProvider = (typeof ASSISTANT_PROVIDERS)[number];

export const ASSISTANT_PROVIDER_LABELS: Record<AssistantProvider, string> = {
  zveno: 'zveno.ai',
};

export const ASSISTANT_MODEL_MAX = 80;

/** Режим работы: обычный агент-ответчик или разбор вставленного текста в статью. */
export const ASSISTANT_MODES = ['agent', 'analysis'] as const;
export type AssistantMode = (typeof ASSISTANT_MODES)[number];
export const ASSISTANT_MODE_LABELS: Record<AssistantMode, string> = {
  agent: 'Агент',
  analysis: 'Анализ',
};

/** Верхний предел обычного сообщения агенту. */
export const ASSISTANT_MESSAGE_MAX = 20_000;
/** В режиме «Анализ» вставляют целую статью/мануал — предел заметно выше. */
export const ASSISTANT_ANALYSIS_MAX = 100_000;

/** Предел длины сообщения зависит от режима. */
export function assistantMessageMax(mode: AssistantMode): number {
  return mode === 'analysis' ? ASSISTANT_ANALYSIS_MAX : ASSISTANT_MESSAGE_MAX;
}

/** Уровень пользователя — насколько подробно и какими терминами отвечать. */
export const ASSISTANT_LEVELS = ['novice', 'intermediate', 'pro'] as const;
export type AssistantLevel = (typeof ASSISTANT_LEVELS)[number];
export const ASSISTANT_LEVEL_LABELS: Record<AssistantLevel, string> = {
  novice: 'Новичок',
  intermediate: 'Средний',
  pro: 'Профессионал',
};
export const ASSISTANT_LEVEL_HINTS: Record<AssistantLevel, string> = {
  novice: 'Максимально подробно и простыми словами, с расшифровкой терминов и аббревиатур.',
  intermediate: 'Баланс: по делу, но поясняет неочевидные термины и шаги.',
  pro: 'Кратко, терминами и аббревиатурами, без разжёвывания базового.',
};
export const ASSISTANT_LEVEL_DEFAULT: AssistantLevel = 'intermediate';

/** Разрешения агента — что ему позволено делать в системе. Настройки он только читает. */
export const ASSISTANT_PERMISSION_KEYS = ['kbWrite', 'glossary', 'kbReview'] as const;
export type AssistantPermission = (typeof ASSISTANT_PERMISSION_KEYS)[number];
export const ASSISTANT_PERMISSION_LABELS: Record<AssistantPermission, string> = {
  kbWrite: 'Создание и редактирование статей',
  glossary: 'Автоглоссарий «Пояснения»',
  kbReview: 'Еженедельная ревизия базы знаний',
};
export const ASSISTANT_PERMISSION_HINTS: Record<AssistantPermission, string> = {
  kbWrite: 'Агент может сам создавать и править статьи в базе знаний (с меткой AI).',
  glossary: 'Непонятные термины и аббревиатуры автоматически попадают в статью «Пояснения».',
  kbReview: 'Раз в неделю агент наводит порядок в базе: чистит артефакты, дополняет, предлагает правки.',
};
export type AssistantPermissions = Record<AssistantPermission, boolean>;
export const ASSISTANT_PERMISSIONS_DEFAULT: AssistantPermissions = {
  kbWrite: true,
  glossary: true,
  kbReview: true,
};

const assistantPermissionsSchema = z.object({
  kbWrite: z.boolean(),
  glossary: z.boolean(),
  kbReview: z.boolean(),
});

export const assistantStatusSchema = z.object({
  /** Ключ и модель заданы — ассистент работает. */
  enabled: z.boolean(),
  provider: z.enum(ASSISTANT_PROVIDERS),
  /** Название модели вводит администратор (например «anthropic/claude-sonnet-4-5»). */
  model: z.string(),
  level: z.enum(ASSISTANT_LEVELS),
  permissions: assistantPermissionsSchema,
});
export type AssistantStatus = z.infer<typeof assistantStatusSchema>;

/** Настройки ассистента (Настройки → Ассистент): ключ приходит только на запись. */
export const assistantSettingsUpdateSchema = z.object({
  provider: z.enum(ASSISTANT_PROVIDERS).optional(),
  apiKey: z.string().trim().min(8).max(400).optional(),
  /** true — стереть ключ (выключить ассистента). */
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

/** Предложение действия — выполняется только после подтверждения администратором. */
export const assistantProposalSchema = z.object({
  kind: z.literal('autofix'),
  incidentId: z.uuid(),
  preset: z.string(),
  title: z.string(),
  description: z.string(),
  /** Уровень действия из реестра. Старые предложения без него: интерфейс берёт уровень из реестра сам. */
  level: z.enum(ACTION_LEVELS).optional(),
  /** Почему ассистент предлагает именно этот шаг (его слова, без последствий из реестра). */
  reason: z.string().optional(),
});
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
    mode: z.enum(ASSISTANT_MODES).default('agent'),
  })
  .superRefine((val, ctx) => {
    // Предел зависит от режима: в «Анализ» вставляют целый мануал, в «Агент» — короткий вопрос.
    const max = assistantMessageMax(val.mode);
    if (val.message.length > max) {
      ctx.addIssue({
        code: 'custom',
        path: ['message'],
        message:
          val.mode === 'analysis'
            ? `Слишком длинный текст: ${val.message.length} из ${max} символов. Разбей мануал на части и собери их по очереди.`
            : `Сообщение слишком длинное: ${val.message.length} из ${max} символов.`,
      });
    }
  });
export type AssistantChatRequest = z.infer<typeof assistantChatRequestSchema>;

export const assistantChatResponseSchema = z.object({
  conversationId: z.uuid(),
  message: assistantMessageSchema,
});
export type AssistantChatResponse = z.infer<typeof assistantChatResponseSchema>;

export const assistantConversationSchema = z.object({
  id: z.uuid(),
  title: z.string(),
  mode: z.enum(ASSISTANT_MODES),
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
