import {
  type ActionKey,
  type Incident,
  type IncidentPolicyResponse,
  type IncidentPolicyUpdate,
  type IncidentsListResponse,
  incidentPolicyResponseSchema,
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
  remove: (id: string): Promise<void> => request(`/incidents/${id}`, { method: 'DELETE' }),
  removeResolved: (): Promise<{ deleted: number }> =>
    request('/incidents/resolved', { method: 'DELETE', schema: z.object({ deleted: z.number().int() }) }),
  /** Запуск действия реестра (T1/T2): попытка идёт в фоне, инцидент перечитывается, пока она идёт. */
  run: (id: string, action: ActionKey): Promise<Incident> =>
    api.post(`/incidents/${id}/actions/${action}/run`, {}, incidentSchema),
  policy: (signal?: AbortSignal): Promise<IncidentPolicyResponse> =>
    api.get('/incidents/policy', incidentPolicyResponseSchema, signal),
  updatePolicy: (body: IncidentPolicyUpdate): Promise<IncidentPolicyResponse> =>
    request('/incidents/policy', { method: 'PATCH', body, schema: incidentPolicyResponseSchema }),
};

export const incidentsKeys = {
  all: ['incidents'] as const,
  lists: ['incidents', 'list'] as const,
  list: (status: IncidentsFilter) => ['incidents', 'list', status] as const,
  item: (id: string) => ['incidents', 'item', id] as const,
  policy: ['incidents', 'policy'] as const,
};

/** Идёт ли по какому-то инциденту попытка — тогда данные перечитываются часто. */
export const hasRunningAttempt = (items: Incident[] | undefined): boolean =>
  Boolean(items?.some((i) => i.attempts.some((a) => a.status === 'running')));

export function useIncidents(status: IncidentsFilter) {
  return useQuery({
    queryKey: incidentsKeys.list(status),
    queryFn: ({ signal }) => incidentsApi.list(status, signal),
    // Живой поток приносит изменения сразу; опрос — страховка. Пока идёт попытка — чаще.
    refetchInterval: (q) => (hasRunningAttempt(q.state.data?.items) ? 2_000 : 60_000),
  });
}

/** Один инцидент для страницы-кейса. */
export function useIncident(id: string) {
  return useQuery({
    queryKey: incidentsKeys.item(id),
    queryFn: ({ signal }) => incidentsApi.get(id, signal),
    refetchInterval: (q) => (hasRunningAttempt(q.state.data ? [q.state.data] : undefined) ? 2_000 : 60_000),
  });
}

/** Лёгкий счётчик открытых инцидентов для навигации и баннера. */
export function useOpenIncidentsCount(): number {
  const q = useQuery({
    queryKey: incidentsKeys.list('open'),
    queryFn: ({ signal }) => incidentsApi.list('open', signal),
    refetchInterval: 60_000,
  });
  return q.data?.counts.open ?? 0;
}

/** Удаление одного инцидента: убираем из кэша списков сразу, потом перечитываем. */
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
  const qc = useQueryClient();
  return useMutation({
    mutationFn: incidentsApi.acknowledge,
    onSuccess: () => void qc.invalidateQueries({ queryKey: incidentsKeys.all }),
  });
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

/** Подтверждение предложения или ручной запуск действия. Пароль не спрашивается — решение владельца. */
export function useRunAction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, action }: { id: string; action: ActionKey }) => incidentsApi.run(id, action),
    onSuccess: () => void qc.invalidateQueries({ queryKey: incidentsKeys.all }),
  });
}

export function useIncidentPolicy() {
  return useQuery({
    queryKey: incidentsKeys.policy,
    queryFn: ({ signal }) => incidentsApi.policy(signal),
    staleTime: 15_000,
  });
}

export function useUpdateIncidentPolicy() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: incidentsApi.updatePolicy,
    onSuccess: (data) => {
      qc.setQueryData(incidentsKeys.policy, data);
      void qc.invalidateQueries({ queryKey: ['settings', 'incidents'] });
    },
  });
}
