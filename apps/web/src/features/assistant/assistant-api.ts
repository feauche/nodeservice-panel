import {
  type AssistantChatResponse,
  type AssistantContextKind,
  type AssistantStatus,
  assistantChatResponseSchema,
  assistantConversationsResponseSchema,
  assistantHistoryResponseSchema,
  assistantStatusSchema,
} from '@nodeservice/shared';
import { useMutation, useMutationState, useQuery, useQueryClient } from '@tanstack/react-query';
import type { z } from 'zod';
import { knowledgeKeys } from '@/features/knowledge/knowledge-api';
import { api } from '@/lib/api';

type ConversationsResponse = z.infer<typeof assistantConversationsResponseSchema>;
type HistoryResponse = z.infer<typeof assistantHistoryResponseSchema>;

export const assistantApi = {
  status: (signal?: AbortSignal): Promise<AssistantStatus> =>
    api.get('/assistant/status', assistantStatusSchema, signal),
  conversations: (signal?: AbortSignal): Promise<ConversationsResponse> =>
    api.get('/assistant/conversations', assistantConversationsResponseSchema, signal),
  history: (id: string, signal?: AbortSignal): Promise<HistoryResponse> =>
    api.get(`/assistant/conversations/${id}`, assistantHistoryResponseSchema, signal),
  chat: (message: string, conversationId?: string, context?: ChatContext): Promise<AssistantChatResponse> =>
    api.post(
      '/assistant/chat',
      { message, ...(conversationId ? { conversationId } : {}), ...(context ? { context } : {}) },
      assistantChatResponseSchema,
    ),
};

/** Выбранная беседа помнится между заходами на страницу. */
export const LAST_CONV_KEY = 'ns.assistant.conversation';
/** Черновик, с которым другой раздел открывает Ассистента (например, разбор конфигов Remnawave). */
export const ASSISTANT_DRAFT_KEY = 'ns.assistant.draft';
/** Ключ запроса чата: по нему любая страница видит, что Ассистент ещё думает, даже если запрос отправили с другой. */
export const CHAT_MUTATION_KEY = ['assistant', 'chat'] as const;
/** Вопрос со страницы события или из окна ноды: сервер подставит Ассистенту их данные. */
export interface ChatContext {
  kind: AssistantContextKind;
  id: string;
}
export interface ChatVars {
  message: string;
  conversationId?: string;
  context?: ChatContext;
}

export const assistantKeys = {
  all: ['assistant'] as const,
  status: ['assistant', 'status'] as const,
  conversations: ['assistant', 'conversations'] as const,
  history: (id: string) => ['assistant', 'history', id] as const,
};

export function useAssistantStatus() {
  return useQuery({
    queryKey: assistantKeys.status,
    queryFn: ({ signal }) => assistantApi.status(signal),
    staleTime: 10_000,
  });
}

export function useConversations() {
  return useQuery({
    queryKey: assistantKeys.conversations,
    queryFn: ({ signal }) => assistantApi.conversations(signal),
  });
}

export function useConversationHistory(id: string | null) {
  return useQuery({
    queryKey: assistantKeys.history(id ?? ''),
    queryFn: ({ signal }) => assistantApi.history(id as string, signal),
    enabled: Boolean(id),
  });
}

/**
 * Запросы чата, которые сейчас в работе. Запрос живёт в кэше запросов, а не в странице, поэтому после ухода
 * в другой раздел и возврата «Ассистент думает» остаётся ровно столько, сколько идёт запрос.
 */
export function usePendingChats(): ChatVars[] {
  return useMutationState({
    filters: { mutationKey: CHAT_MUTATION_KEY, status: 'pending' },
    select: (m) => m.state.variables as ChatVars,
  });
}

export function useSendMessage() {
  const qc = useQueryClient();
  return useMutation({
    mutationKey: CHAT_MUTATION_KEY,
    mutationFn: ({ message, conversationId, context }: ChatVars) =>
      assistantApi.chat(message, conversationId, context),
    onSuccess: (res, vars) => {
      // Новый чат закончился, пока страницы Ассистента не было на экране: запоминаем беседу, чтобы вернуться в неё.
      if (!vars.conversationId) {
        try {
          if (!localStorage.getItem(LAST_CONV_KEY)) localStorage.setItem(LAST_CONV_KEY, res.conversationId);
        } catch {
          // приватный режим браузера: беседа найдётся в списке
        }
      }
      void qc.invalidateQueries({ queryKey: assistantKeys.conversations });
      void qc.invalidateQueries({ queryKey: assistantKeys.history(res.conversationId) });
      // Ассистент мог записать статью в базу знаний — освежаем её, чтобы статья сразу появилась.
      void qc.invalidateQueries({ queryKey: knowledgeKeys.all });
    },
  });
}
