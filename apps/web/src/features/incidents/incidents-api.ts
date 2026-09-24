import {
  type ActionKey,
  type Incident,
  type IncidentActionsResponse,
  type IncidentActionsUpdate,
  type IncidentsListResponse,
  incidentActionsResponseSchema,
  incidentSchema,
  incidentsListResponseSchema,
  type ResolveIncidentRequest,
} from '@nodeservice/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';

import { api, request } from '@/lib/api';

export type IncidentsFilter = 'all' | 'open' | 'resolved';

export const incidentsApi = {
  list: (status: IncidentsFilter, signal?: AbortSignal): Promise<IncidentsListResponse> =>
    api.get(`/incidents?status=${status}`, incidentsListResponseSchema, signal),
  get: (id: string, signal?: AbortSignal): Promise<Incident> =>
    api.get(`/incidents/${id}`, incidentSchema, signal),
  acknowledge: (id: string): Promise<Incident> =>
    api.post(`/incidents/${id}/acknowledge`, {}, incidentSchema),
  resolve: (id: string, body: ResolveIncidentRequest = {}): Promise<Incident> =>
    api.post(`/incidents/${id}/resolve`, body, incidentSchema),
  /** Запуск действия реестра (T1/T2): попытка идёт в фоне, инцидент перечитывается, пока она идёт. */
  run: (id: string, action: ActionKey): Promise<Incident> =>
    api.post(`/incidents/${id}/actions/${action}/run`, {}, incidentSchema),
  remove: (id: string): Promise<void> => request(`/incidents/${id}`, { method: 'DELETE' }),
  removeResolved: (): Promise<{ deleted: number }> =>
    request('/incidents/resolved', { method: 'DELETE', schema: z.object({ deleted: z.number().int() }) }),
  actions: (signal?: AbortSignal): Promise<IncidentActionsResponse> =>
    api.get('/incidents/actions', incidentActionsResponseSchema, signal),
  updateActions: (body: IncidentActionsUpdate): Promise<IncidentActionsResponse> =>
    request('/incidents/actions', { method: 'PATCH', body, schema: incidentActionsResponseSchema }),
};

export const incidentsKeys = {
  all: ['incidents'] as const,
  lists: ['incidents', 'list'] as const,
  list: (status: IncidentsFilter) => ['incidents', 'list', status] as const,
  actions: ['incidents', 'actions'] as const,
};

/** Идёт ли по какому-то инциденту попытка — тогда список перечитывается часто. */
export const hasRunningAttempt = (items: Incident[] | undefined): boolean =>
  Boolean(items?.some((i) => i.attempts.some((a) => a.status === 'running')));

export function useIncidents(status: IncidentsFilter) {
  return useQuery({
    queryKey: incidentsKeys.list(status),
    queryFn: ({ signal }) => incidentsApi.list(status, signal),
    refetchInterval: (q) => (hasRunningAttempt(q.state.data?.items) ? 2_000 : 20_000),
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

/** Удаление одного инцидента: убираем из кэша сразу, потом перечитываем. */
export function useDeleteIncident() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: incidentsApi.remove,
    onSuccess: (_d, id) => {
      qc.setQueriesData<IncidentsListResponse>({ queryKey: incidentsKeys.lists }, (cur) =>
        cur ? { ...cur, items: cur.items.filter((i) => i.id !== id) } : cur,
      );
      void qc.invalidateQueries({ queryKey: incidentsKeys.all });
    },
  });
}
export function useDeleteResolvedIncidents() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: incidentsApi.removeResolved,
    onSuccess: () => void qc.invalidateQueries({ queryKey: incidentsKeys.all }),
  });
}

export function useAcknowledgeIncident() {
  return useIncidentAction(incidentsApi.acknowledge);
}
/** Ручное закрытие; с «больше не следить за нодой» меняется и сервер — перечитываем и его. */
export function useResolveIncident() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: { id: string } & ResolveIncidentRequest) => incidentsApi.resolve(id, body),
    onSuccess: (_d, vars) => {
      void qc.invalidateQueries({ queryKey: incidentsKeys.all });
      if (vars.stopNodeWatch) void qc.invalidateQueries({ queryKey: ['servers'] });
    },
  });
}

/** подтверждение предложения или ручной запуск действия. Пароль не спрашивается — решение владельца. */
export function useRunAction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, action }: { id: string; action: ActionKey }) => incidentsApi.run(id, action),
    onSuccess: () => void qc.invalidateQueries({ queryKey: incidentsKeys.all }),
  });
}

export function useIncidentActions() {
  return useQuery({
    queryKey: incidentsKeys.actions,
    queryFn: ({ signal }) => incidentsApi.actions(signal),
    staleTime: 15_000,
  });
}

export function useUpdateIncidentActions() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: incidentsApi.updateActions,
    onSuccess: (data) => {
      qc.setQueryData(incidentsKeys.actions, data);
      void qc.invalidateQueries({ queryKey: ['settings', 'incidents'] });
    },
  });
}
