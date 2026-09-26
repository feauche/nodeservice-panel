import {
  type AssistantChatResponse,
  type AssistantStatus,
  assistantChatResponseSchema,
  assistantConversationsResponseSchema,
  assistantHistoryResponseSchema,
  assistantStatusSchema,
} from '@nodeservice/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
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
  chat: (message: string, conversationId?: string): Promise<AssistantChatResponse> =>
    api.post(
      '/assistant/chat',
      { message, ...(conversationId ? { conversationId } : {}) },
      assistantChatResponseSchema,
    ),
};

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

export function useSendMessage() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ message, conversationId }: { message: string; conversationId?: string }) =>
      assistantApi.chat(message, conversationId),
    onSuccess: (res) => {
      void qc.invalidateQueries({ queryKey: assistantKeys.conversations });
      void qc.invalidateQueries({ queryKey: assistantKeys.history(res.conversationId) });
      // Агент мог создать статью — освежаем базу знаний, чтобы она сразу появилась.
      void qc.invalidateQueries({ queryKey: knowledgeKeys.all });
    },
  });
}
