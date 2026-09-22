import {
  type AutofixPresetKey,
  type Incident,
  type IncidentsListResponse,
  incidentSchema,
  incidentsListResponseSchema,
} from '@nodeservice/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { withStepUp } from '@/features/security/step-up';
import { api } from '@/lib/api';

export type IncidentsFilter = 'all' | 'open' | 'resolved';

export const incidentsApi = {
  list: (status: IncidentsFilter, signal?: AbortSignal): Promise<IncidentsListResponse> =>
    api.get(`/incidents?status=${status}`, incidentsListResponseSchema, signal),
  get: (id: string, signal?: AbortSignal): Promise<Incident> =>
    api.get(`/incidents/${id}`, incidentSchema, signal),
  acknowledge: (id: string): Promise<Incident> =>
    api.post(`/incidents/${id}/acknowledge`, {}, incidentSchema),
  resolve: (id: string): Promise<Incident> => api.post(`/incidents/${id}/resolve`, {}, incidentSchema),
  autofix: (id: string, preset: AutofixPresetKey): Promise<Incident> =>
    api.post(`/incidents/${id}/autofix`, { preset }, incidentSchema),
};

export const incidentsKeys = {
  all: ['incidents'] as const,
  list: (status: IncidentsFilter) => ['incidents', 'list', status] as const,
};

export function useIncidents(status: IncidentsFilter) {
  return useQuery({
    queryKey: incidentsKeys.list(status),
    queryFn: ({ signal }) => incidentsApi.list(status, signal),
    refetchInterval: 20_000,
  });
}

/** Лёгкий счётчик открытых инцидентов для навигации и баннера. */
export function useOpenIncidentsCount(): number {
  const q = useQuery({
    queryKey: incidentsKeys.list('open'),
    queryFn: ({ signal }) => incidentsApi.list('open', signal),
    refetchInterval: 30_000,
  });
  return q.data?.counts.open ?? 0;
}

function useIncidentAction(fn: (id: string) => Promise<Incident>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: () => void qc.invalidateQueries({ queryKey: incidentsKeys.all }),
  });
}

export function useAcknowledgeIncident() {
  return useIncidentAction(incidentsApi.acknowledge);
}
export function useResolveIncident() {
  return useIncidentAction(incidentsApi.resolve);
}

/** Автопочинка требует свежего подтверждения паролем (step-up на сервере). */
export function useRunAutofix() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, preset }: { id: string; preset: AutofixPresetKey }) =>
      withStepUp(() => incidentsApi.autofix(id, preset)),
    onSuccess: () => void qc.invalidateQueries({ queryKey: incidentsKeys.all }),
  });
}
