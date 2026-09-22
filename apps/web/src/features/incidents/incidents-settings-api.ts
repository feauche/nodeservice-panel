import {
  type IncidentsSettings,
  type IncidentsSettingsUpdate,
  incidentsSettingsSchema,
} from '@nodeservice/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { api } from '@/lib/api';

export const incidentsSettingsQuery = {
  queryKey: ['settings', 'incidents'] as const,
  queryFn: ({ signal }: { signal?: AbortSignal }): Promise<IncidentsSettings> =>
    api.get('/settings/incidents', incidentsSettingsSchema, signal),
  staleTime: 30_000,
};

export function useIncidentsSettings() {
  return useQuery(incidentsSettingsQuery);
}

export function useUpdateIncidentsSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: IncidentsSettingsUpdate): Promise<IncidentsSettings> =>
      api.put('/settings/incidents', body, incidentsSettingsSchema),
    onSuccess: (data) => qc.setQueryData(incidentsSettingsQuery.queryKey, data),
  });
}
