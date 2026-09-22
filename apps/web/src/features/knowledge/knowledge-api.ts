import {
  type KbDoc,
  type KbDocCreate,
  type KbDocUpdate,
  type KbListResponse,
  type KbVersionsResponse,
  kbDocSchema,
  kbListResponseSchema,
  kbVersionsResponseSchema,
} from '@nodeservice/shared';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { api, request } from '@/lib/api';

export const knowledgeApi = {
  list: (q: string, archived: boolean, signal?: AbortSignal): Promise<KbListResponse> =>
    api.get(
      `/knowledge?archived=${archived}${q ? `&q=${encodeURIComponent(q)}` : ''}`,
      kbListResponseSchema,
      signal,
    ),
  get: (id: string, signal?: AbortSignal): Promise<KbDoc> => api.get(`/knowledge/${id}`, kbDocSchema, signal),
  create: (body: KbDocCreate): Promise<KbDoc> => api.post('/knowledge', body, kbDocSchema),
  update: (id: string, body: KbDocUpdate): Promise<KbDoc> => api.put(`/knowledge/${id}`, body, kbDocSchema),
  remove: (id: string): Promise<void> => request(`/knowledge/${id}`, { method: 'DELETE' }),
  versions: (id: string, signal?: AbortSignal): Promise<KbVersionsResponse> =>
    api.get(`/knowledge/${id}/versions`, kbVersionsResponseSchema, signal),
  revert: (id: string, versionId: string): Promise<KbDoc> =>
    api.post(`/knowledge/${id}/versions/${versionId}/revert`, {}, kbDocSchema),
};

export const knowledgeKeys = {
  all: ['knowledge'] as const,
  list: (q: string, archived: boolean) => ['knowledge', 'list', q, archived] as const,
  doc: (id: string) => ['knowledge', 'doc', id] as const,
  versions: (id: string) => ['knowledge', 'versions', id] as const,
};

export function useKbList(q: string, archived: boolean) {
  return useQuery({
    queryKey: knowledgeKeys.list(q, archived),
    queryFn: ({ signal }) => knowledgeApi.list(q, archived, signal),
    staleTime: 10_000,
    // Открыли базу знаний — всегда берём свежий список: агент мог только что создать статью
    // (например, глоссарий «Пояснения»), и она должна быть видна сразу.
    refetchOnMount: 'always',
    // При наборе в поиске (меняется ключ запроса) держим прошлые результаты, пока грузятся новые —
    // без этого список мигает скелетоном на каждый символ.
    placeholderData: keepPreviousData,
  });
}

export function useKbDoc(id: string | null) {
  return useQuery({
    queryKey: knowledgeKeys.doc(id ?? ''),
    queryFn: ({ signal }) => knowledgeApi.get(id as string, signal),
    enabled: Boolean(id),
  });
}

export function useCreateKbDoc() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: knowledgeApi.create,
    onSuccess: () => void qc.invalidateQueries({ queryKey: knowledgeKeys.all }),
  });
}

export function useUpdateKbDoc() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: KbDocUpdate }) => knowledgeApi.update(id, patch),
    onSuccess: () => void qc.invalidateQueries({ queryKey: knowledgeKeys.all }),
  });
}

export function useDeleteKbDoc() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: knowledgeApi.remove,
    onSuccess: () => void qc.invalidateQueries({ queryKey: knowledgeKeys.all }),
  });
}

export function useKbVersions(id: string | null, enabled: boolean) {
  return useQuery({
    queryKey: knowledgeKeys.versions(id ?? ''),
    queryFn: ({ signal }) => knowledgeApi.versions(id as string, signal),
    enabled: Boolean(id) && enabled,
  });
}

export function useRevertKbDoc() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, versionId }: { id: string; versionId: string }) => knowledgeApi.revert(id, versionId),
    onSuccess: () => void qc.invalidateQueries({ queryKey: knowledgeKeys.all }),
  });
}
