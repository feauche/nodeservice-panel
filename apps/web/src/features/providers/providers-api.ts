import {
  type CreateProviderRequest,
  type Provider,
  type ProviderIconPreviewResponse,
  type ProvidersResponse,
  providerIconPreviewResponseSchema,
  providerSchema,
  providersResponseSchema,
  type UpdateProviderRequest,
} from '@nodeservice/shared';
import { queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';

import { serversKeys } from '@/features/servers/servers-api';
import { API_BASE, api, request } from '@/lib/api';

/** /api/providers — справочник хостеров по контракту packages/shared/src/providers.ts. */
export const providersApi = {
  list: (signal?: AbortSignal): Promise<ProvidersResponse> =>
    api.get('/providers', providersResponseSchema, signal),
  create: (body: CreateProviderRequest): Promise<Provider> => api.post('/providers', body, providerSchema),
  update: (id: string, body: UpdateProviderRequest): Promise<Provider> =>
    request(`/providers/${id}`, { method: 'PATCH', body, schema: providerSchema }),
  remove: (id: string): Promise<void> => request(`/providers/${id}`, { method: 'DELETE' }),
  refreshIcon: (id: string): Promise<Provider> =>
    api.post(`/providers/${id}/icon/refresh`, {}, providerSchema),
  preview: (siteUrl: string, iconUrl?: string | null): Promise<ProviderIconPreviewResponse> =>
    api.post(
      '/providers/icon-preview',
      { siteUrl, ...(iconUrl ? { iconUrl } : {}) },
      providerIconPreviewResponseSchema,
    ),
  servers: (id: string, signal?: AbortSignal) =>
    api.get(`/providers/${id}/servers`, z.array(z.object({ id: z.uuid(), name: z.string() })), signal),
};

export const providersKeys = {
  list: ['providers', 'list'] as const,
  servers: (id: string) => ['providers', 'servers', id] as const,
};

/** Адрес картинки-иконки; версия в query ломает кэш браузера после обновления иконки. */
export function providerIconUrl(p: Pick<Provider, 'id' | 'iconVersion'>): string {
  return `${API_BASE}/providers/${p.id}/icon?v=${p.iconVersion}`;
}

export const providersListQuery = queryOptions({
  queryKey: providersKeys.list,
  queryFn: ({ signal }) => providersApi.list(signal),
  staleTime: 60_000,
});

export function useProviders() {
  return useQuery({
    ...providersListQuery,
    // Иконка ищется в фоне: пока у кого-то iconPending, перечитываем список.
    refetchInterval: (q) => (q.state.data?.items.some((p) => p.iconPending) ? 1500 : false),
  });
}

export function useProviderServers(id: string | null) {
  return useQuery({
    queryKey: providersKeys.servers(id ?? ''),
    queryFn: ({ signal }) => providersApi.servers(id ?? '', signal),
    enabled: id !== null,
    staleTime: 15_000,
  });
}

function useInvalidate() {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: ['providers'] });
    // У серверов меняется providerId/иконка — список серверов тоже перечитываем.
    void qc.invalidateQueries({ queryKey: serversKeys.all });
  };
}

export function useCreateProvider() {
  const inv = useInvalidate();
  return useMutation({ mutationFn: providersApi.create, onSuccess: inv });
}

export function useUpdateProvider() {
  const inv = useInvalidate();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: UpdateProviderRequest }) => providersApi.update(id, body),
    onSuccess: inv,
  });
}

export function useDeleteProvider() {
  const inv = useInvalidate();
  return useMutation({ mutationFn: providersApi.remove, onSuccess: inv });
}

export function useRefreshProviderIcon() {
  const inv = useInvalidate();
  return useMutation({ mutationFn: providersApi.refreshIcon, onSuccess: inv });
}
