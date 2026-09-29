import { type Capacity, capacitySchema, type ServerLink, serverLinkSchema } from '@nodeservice/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { api, request } from '@/lib/api';

export const capacityKey = ['fleet', 'capacity'] as const;

/** «Обзор» → «Ёмкость»: сервер считает раз в час, отдаёт из памяти. */
export function useCapacity() {
  return useQuery({
    queryKey: capacityKey,
    queryFn: ({ signal }): Promise<Capacity> => api.get('/fleet/capacity', capacitySchema, signal),
    staleTime: 60_000,
    refetchInterval: 10 * 60_000,
  });
}

export function useRecomputeCapacity() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (): Promise<Capacity> => api.post('/fleet/capacity/refresh', {}, capacitySchema),
    onSuccess: (data) => qc.setQueryData(capacityKey, data),
  });
}

/** После замера или правки канала — пересчитать, чтобы таблица сразу показала новое. */
function useAfterLink() {
  const qc = useQueryClient();
  return async () => {
    const fresh = await api.post('/fleet/capacity/refresh', {}, capacitySchema).catch(() => null);
    if (fresh) qc.setQueryData(capacityKey, fresh);
    else await qc.invalidateQueries({ queryKey: capacityKey });
  };
}

export function useMeasureLink() {
  const after = useAfterLink();
  return useMutation({
    mutationFn: (serverId: string): Promise<ServerLink> =>
      api.post(`/servers/${serverId}/link/measure`, {}, serverLinkSchema),
    onSuccess: () => void after(),
  });
}

export function useSetManualLink() {
  const after = useAfterLink();
  return useMutation({
    mutationFn: ({
      serverId,
      manualMbit,
    }: {
      serverId: string;
      manualMbit: number | null;
    }): Promise<ServerLink> =>
      request(`/servers/${serverId}/link`, { method: 'PUT', body: { manualMbit }, schema: serverLinkSchema }),
    onSuccess: () => void after(),
  });
}
