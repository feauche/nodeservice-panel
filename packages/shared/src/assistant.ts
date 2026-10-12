import { z } from 'zod';

/**
 * Ассистент: чат, который читает панель и Remnawave. Сам он ничего не меняет и не запускает, кроме записи
 * в базу знаний (статьи и «Пояснения»); проверки только советует — запускает их владелец.
 */

/** Провайдеры LLM. Пока один — zveno.ai (OpenAI-совместимый шлюз); список будем дополнять. */
export const ASSISTANT_PROVIDERS = ['zveno'] as const;
export type AssistantProvider = (typeof ASSISTANT_PROVIDERS)[number];

export const ASSISTANT_PROVIDER_LABELS: Record<AssistantProvider, string> = {
  zveno: 'zveno.ai',
};

export const ASSISTANT_MODEL_MAX = 80;

/**
 * Верхний предел сообщения Ассистенту. Режима «Анализ» больше нет: Ассистент сам понимает, что ему прислали
 * (вопрос, статью, словарь терминов, вывод команды), поэтому в чат можно вставить целый мануал.
 */
export const ASSISTANT_MESSAGE_MAX = 100_000;

/**
 * Подробность ответов Ассистента. Ключи остались прежними (novice, intermediate, pro), поэтому старые
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

export const assistantStatusSchema = z.object({
  /** Ключ и модель заданы — Ассистент работает. */
  enabled: z.boolean(),
  provider: z.enum(ASSISTANT_PROVIDERS),
  /** Название модели вводит администратор (например «anthropic/claude-sonnet-4-5»). */
  model: z.string(),
  level: z.enum(ASSISTANT_LEVELS),
});
export type AssistantStatus = z.infer<typeof assistantStatusSchema>;

/** Настройки Ассистента (Настройки → Ассистент): ключ приходит только на запись. */
export const assistantSettingsUpdateSchema = z.object({
  provider: z.enum(ASSISTANT_PROVIDERS).optional(),
  apiKey: z.string().trim().min(8).max(400).optional(),
  /** true — стереть ключ (выключить Ассистента). */
  clearKey: z.boolean().optional(),
  model: z.string().trim().max(ASSISTANT_MODEL_MAX).optional(),
  level: z.enum(ASSISTANT_LEVELS).optional(),
});
export type AssistantSettingsUpdate = z.infer<typeof assistantSettingsUpdateSchema>;

/** Ссылка-цитата на источник ответа. */
export const assistantCitationSchema = z.object({
  type: z.enum(['node', 'server', 'incident', 'audit', 'kb', 'metric']),
  id: z.string(),
  label: z.string(),
});
export type AssistantCitation = z.infer<typeof assistantCitationSchema>;

/** Проверки, которые Ассистент может посоветовать. Запускает их владелец: Ассистент только советует. */
export const ASSISTANT_CHECKS = ['tcp', 'dpi', 'bs'] as const;
export type AssistantCheck = (typeof ASSISTANT_CHECKS)[number];
export const ASSISTANT_CHECK_LABELS: Record<AssistantCheck, string> = {
  tcp: 'Порт через Check-Host',
  dpi: 'DPI Checker, IP-проверка',
  bs: 'BS Checker',
};
/** Не больше стольких советов под одним ответом: третий совет уже шум. */
export const ASSISTANT_ADVICE_MAX = 2;

/** Совет проверить ноду. Под ответом становится карточкой с кнопкой «Открыть проверку». */
export const assistantAdviceSchema = z.object({
  check: z.enum(ASSISTANT_CHECKS),
  nodeUuid: z.string(),
  /** Имя и адрес на момент совета: нода могла пропасть из Remnawave, а карточка должна читаться. */
  nodeName: z.string(),
  address: z.string().nullable(),
  /** Одна фраза владельцу: зачем эта проверка. */
  reason: z.string(),
});
export type AssistantAdvice = z.infer<typeof assistantAdviceSchema>;

/** Откуда задан вопрос: со страницы события или из окна ноды. */
export const ASSISTANT_CONTEXT_KINDS = ['incident', 'node'] as const;
export type AssistantContextKind = (typeof ASSISTANT_CONTEXT_KINDS)[number];
export const assistantContextRefSchema = z.object({
  kind: z.enum(ASSISTANT_CONTEXT_KINDS),
  id: z.string().trim().min(1).max(64),
});
/** Метка над вопросом: «Событие: Нода недоступна · nl-ams-02» или «Нода: CONTEL». */
export const assistantContextSchema = assistantContextRefSchema.extend({ label: z.string() });
export type AssistantContext = z.infer<typeof assistantContextSchema>;

export const assistantMessageSchema = z.object({
  id: z.uuid(),
  role: z.enum(['user', 'assistant']),
  content: z.string(),
  citations: z.array(assistantCitationSchema).default([]),
  /** Советы проверок под ответом Ассистента. Сервер присылает всегда; у старых сообщений поля нет. */
  advice: z.array(assistantAdviceSchema).optional(),
  /** У вопроса, заданного со страницы события или из окна ноды, — откуда он задан. */
  context: assistantContextSchema.nullable().optional(),
  createdAt: z.iso.datetime(),
});
export type AssistantMessage = z.infer<typeof assistantMessageSchema>;

export const assistantChatRequestSchema = z
  .object({
    message: z.string().trim().min(1),
    conversationId: z.uuid().optional(),
    /** Вопрос задан со страницы события или из окна ноды: сервер сам подставит Ассистенту их данные. */
    context: assistantContextRefSchema.optional(),
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
  'Когда был пик онлайна за сутки?',
  'Какие ноды под нагрузкой?',
  'Что показала последняя TCP-проверка?',
  'Что было в Журнале за час?',
] as const;
