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
import { createContext, useContext } from 'react';
import { z } from 'zod';
export const ProvidersSourceContext = createContext('/providers');
export const useProviderApiBase = () => useContext(ProvidersSourceContext);
function useSourceApi() {
  const base = useProviderApiBase();
  return base === '/providers'
    ? providersApi
    : {
        list: (signal?: AbortSignal) => api.get(base, providersResponseSchema, signal),
        create: (body: CreateProviderRequest) => api.post(base, body, providerSchema),
        update: (id: string, body: UpdateProviderRequest) =>
          request(`${base}/${id}`, { method: 'PATCH', body, schema: providerSchema }),
        remove: (id: string) => request(`${base}/${id}`, { method: 'DELETE' }),
        refreshIcon: (id: string) => api.post(`${base}/${id}/icon/refresh`, {}, providerSchema),
        servers: (id: string, signal?: AbortSignal) =>
          api.get(`${base}/${id}/servers`, z.array(z.object({ id: z.uuid(), name: z.string() })), signal),
      };
}

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
export function providerIconUrl(p: Pick<Provider, 'id' | 'iconVersion'>, base = '/providers'): string {
  return `${API_BASE}${base}/${p.id}/icon?v=${p.iconVersion}`;
}

export const providersListQuery = queryOptions({
  queryKey: providersKeys.list,
  queryFn: ({ signal }) => providersApi.list(signal),
  staleTime: 60_000,
});

export function useProviders() {
  const source = useSourceApi(),
    base = useProviderApiBase();
  return useQuery({
    staleTime: base === '/providers' ? 60_000 : 10_000,
    queryKey: base === '/providers' ? providersKeys.list : [...providersKeys.list, base],
    queryFn: ({ signal }) => source.list(signal),
    // Иконка ищется в фоне: пока у кого-то iconPending, перечитываем список.
    refetchInterval: (q) =>
      q.state.data?.items.some((p) => p.iconPending) ? 1500 : base === '/providers' ? false : 15_000,
  });
}

export function useProviderServers(id: string | null) {
  const source = useSourceApi(),
    base = useProviderApiBase();
  return useQuery({
    queryKey:
      base === '/providers' ? providersKeys.servers(id ?? '') : [...providersKeys.servers(id ?? ''), base],
    queryFn: ({ signal }) => source.servers(id ?? '', signal),
    enabled: id !== null,
    staleTime: 15_000,
    refetchInterval: base === '/providers' ? false : 15_000,
  });
}

function useInvalidate() {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: ['providers'] });
    void qc.invalidateQueries({ queryKey: ['remna-providers'] });
    void qc.invalidateQueries({ queryKey: ['nodes'] });
    // У серверов меняется providerId/иконка — список серверов тоже перечитываем.
    void qc.invalidateQueries({ queryKey: serversKeys.all });
  };
}

export function useCreateProvider() {
  const inv = useInvalidate(),
    source = useSourceApi();
  return useMutation({ mutationFn: source.create, onSuccess: inv });
}

export function useUpdateProvider() {
  const inv = useInvalidate(),
    source = useSourceApi();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: UpdateProviderRequest }) => source.update(id, body),
    onSuccess: inv,
  });
}

export function useDeleteProvider() {
  const inv = useInvalidate(),
    source = useSourceApi();
  return useMutation({ mutationFn: source.remove, onSuccess: inv });
}

export function useRefreshProviderIcon() {
  const inv = useInvalidate(),
    source = useSourceApi();
  return useMutation({ mutationFn: source.refreshIcon, onSuccess: inv });
}
