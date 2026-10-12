import {
  type NodeLayout,
  type NodePreferences,
  nodeLayoutSchema,
  nodePreferencesSchema,
  type RemnaProviderUpdate,
  type RemnawaveConnectRequest,
  remnaPermissionsSchema,
  remnaProvidersSchema,
  remnawaveStatusSchema,
} from '@nodeservice/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, request } from '@/lib/api';

const key = ['nodes', 'status'] as const;
export function useNodes() {
  return useQuery({
    queryKey: key,
    queryFn: ({ signal }) => api.get('/nodes/status', remnawaveStatusSchema, signal),
    staleTime: 15_000,
    refetchInterval: 15_000,
  });
}
export function useConnectNodes() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: RemnawaveConnectRequest) => api.post('/nodes/connect', body, remnawaveStatusSchema),
    onSuccess: (status) => {
      client.setQueryData(key, status);
      void client.invalidateQueries({ queryKey: ['nodes', 'layout'] });
      void client.invalidateQueries({ queryKey: ['nodes', 'permissions'] });
      void client.invalidateQueries({ queryKey: ['providers'] });
      void client.invalidateQueries({ queryKey: ['remnawave'] });
    },
  });
}
export function useRefreshNodes() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => api.post('/nodes/refresh', {}, remnawaveStatusSchema),
    onSuccess: (status) => client.setQueryData(key, status),
  });
}
export function useDisconnectNodes() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => request('/nodes/connection', { method: 'DELETE' }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: key });
      void client.invalidateQueries({ queryKey: ['remnawave'] });
    },
  });
}

export function useNodePreferences(uuid: string) {
  return useQuery({
    queryKey: ['nodes', 'preferences', uuid],
    queryFn: ({ signal }) => api.get(`/nodes/${uuid}/preferences`, nodePreferencesSchema, signal),
  });
}
export function useSaveNodePreferences(uuid: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: NodePreferences) => api.put(`/nodes/${uuid}/preferences`, body, nodePreferencesSchema),
    onSuccess: (data) => {
      client.setQueryData(['nodes', 'preferences', uuid], data);
      void client.invalidateQueries({ queryKey: key });
    },
  });
}
export function useRemnaProviders() {
  return useQuery({
    queryKey: ['remna-providers'],
    queryFn: ({ signal }) => api.get('/nodes/providers', remnaProvidersSchema, signal),
    refetchInterval: 15_000,
    staleTime: 10_000,
  });
}
export function useUpdateRemnaProvider(uuid: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: RemnaProviderUpdate) => request(`/nodes/providers/${uuid}`, { method: 'PATCH', body }),
    onSuccess: async (_, body) => {
      client.setQueryData(
        ['remna-providers'],
        (old: { providers: import('@nodeservice/shared').RemnaProvider[] } | undefined) =>
          old ? { providers: old.providers.map((p) => (p.uuid === uuid ? { ...p, ...body } : p)) } : old,
      );
      await Promise.all([
        client.invalidateQueries({ queryKey: ['remna-providers'] }),
        client.invalidateQueries({ queryKey: key }),
      ]);
    },
  });
}

export function useNodeLayout(enabled = true) {
  return useQuery({
    queryKey: ['nodes', 'layout'],
    queryFn: ({ signal }) => api.get('/nodes/layout', nodeLayoutSchema, signal),
    enabled,
  });
}
export function useSaveNodeLayout() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (value: NodeLayout) => api.put('/nodes/layout', value, nodeLayoutSchema),
    onSuccess: (data) => client.setQueryData(['nodes', 'layout'], data),
  });
}

export function useRemnaPermissions(enabled: boolean) {
  return useQuery({
    queryKey: ['nodes', 'permissions'],
    queryFn: ({ signal }) => api.get('/nodes/permissions', remnaPermissionsSchema, signal),
    enabled,
    // Каждая перепроверка — шесть запросов в Remnawave; права меняются редко, раза в 30 секунд хватает.
    refetchInterval: 30_000,
  });
}
export function useAssignNodeProvider(uuid: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (providerUuid: string | null) =>
      request(`/nodes/${uuid}/provider`, { method: 'PATCH', body: { providerUuid } }),
    onSuccess: () =>
      Promise.all([
        client.invalidateQueries({ queryKey: ['nodes'] }),
        client.invalidateQueries({ queryKey: ['remna-providers'] }),
        client.invalidateQueries({ queryKey: ['providers'] }),
      ]),
  });
}

export function useCheckRemnaPermissions() {
  return useMutation({
    mutationFn: (body: RemnawaveConnectRequest) =>
      api.post('/nodes/permissions', body, remnaPermissionsSchema),
  });
}
