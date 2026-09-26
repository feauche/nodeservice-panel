import {
  type AssistantChange,
  type AssistantChatResponse,
  type AssistantStatus,
  assistantChangeSchema,
  assistantChatResponseSchema,
  assistantConversationsResponseSchema,
  assistantHistoryResponseSchema,
  assistantStatusSchema,
} from '@nodeservice/shared';
import { useMutation, useMutationState, useQuery, useQueryClient } from '@tanstack/react-query';
import type { z } from 'zod';
import { incidentsKeys } from '@/features/incidents/incidents-api';
import { knowledgeKeys } from '@/features/knowledge/knowledge-api';
import { serversKeys } from '@/features/servers/servers-api';
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
  chat: (message: string, conversationId?: string): Promise<AssistantChatResponse> =>
    api.post(
      '/assistant/chat',
      { message, ...(conversationId ? { conversationId } : {}) },
      assistantChatResponseSchema,
    ),
};

/** Что человек делает с предложенным изменением: применяет, отклоняет или отменяет применённое. */
export type ChangeAction = 'apply' | 'reject' | 'revert';

export const changesApi = {
  get: (id: string, signal?: AbortSignal): Promise<AssistantChange> =>
    api.get(`/assistant/changes/${id}`, assistantChangeSchema, signal),
  act: (id: string, action: ChangeAction): Promise<AssistantChange> =>
    api.post(`/assistant/changes/${id}/${action}`, {}, assistantChangeSchema),
};

/** Выбранная беседа помнится между заходами на страницу. */
export const LAST_CONV_KEY = 'ns.assistant.conversation';
/** Ключ запроса чата: по нему любая страница видит, что Джарвис ещё думает, даже если запрос отправили с другой. */
export const CHAT_MUTATION_KEY = ['assistant', 'chat'] as const;
export interface ChatVars {
  message: string;
  conversationId?: string;
}

export const assistantKeys = {
  all: ['assistant'] as const,
  status: ['assistant', 'status'] as const,
  conversations: ['assistant', 'conversations'] as const,
  history: (id: string) => ['assistant', 'history', id] as const,
  change: (id: string) => ['assistant', 'change', id] as const,
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
 * в другой раздел и возврата «Джарвис думает» остаётся ровно столько, сколько идёт запрос.
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
    mutationFn: ({ message, conversationId }: ChatVars) => assistantApi.chat(message, conversationId),
    onSuccess: (res, vars) => {
      // Новый чат закончился, пока страницы Джарвиса не было на экране: запоминаем беседу, чтобы вернуться в неё.
      if (!vars.conversationId) {
        try {
          if (!localStorage.getItem(LAST_CONV_KEY)) localStorage.setItem(LAST_CONV_KEY, res.conversationId);
        } catch {
          // приватный режим браузера: беседа найдётся в списке
        }
      }
      void qc.invalidateQueries({ queryKey: assistantKeys.conversations });
      void qc.invalidateQueries({ queryKey: assistantKeys.history(res.conversationId) });
      // Агент мог создать статью — освежаем базу знаний, чтобы она сразу появилась.
      void qc.invalidateQueries({ queryKey: knowledgeKeys.all });
    },
  });
}

/** Состояние изменения по предложению Джарвиса: карточка берёт его отсюда, поэтому переживает перезагрузку страницы. */
export function useChange(id: string) {
  return useQuery({
    queryKey: assistantKeys.change(id),
    queryFn: ({ signal }) => changesApi.get(id, signal),
    staleTime: 5_000,
    // Обслуживание идёт в фоне: пока оно идёт, ход в карточке обновляется сам.
    refetchInterval: (query) => (query.state.data?.live ? 3_000 : false),
  });
}

export function useChangeAction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, action }: { id: string; action: ChangeAction }) => changesApi.act(id, action),
    onSuccess: (change) => {
      qc.setQueryData(assistantKeys.change(change.id), change);
      // Применение и откат меняют серверы, инциденты и автопочинку и добавляют запись в Журнал.
      void qc.invalidateQueries({ queryKey: serversKeys.all });
      void qc.invalidateQueries({ queryKey: incidentsKeys.all });
      void qc.invalidateQueries({ queryKey: ['audit'] });
    },
  });
}
