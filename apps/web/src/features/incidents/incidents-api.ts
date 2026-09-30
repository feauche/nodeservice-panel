import {
  type ActionKey,
  type Incident,
  type IncidentPolicyResponse,
  type IncidentPolicyUpdate,
  type IncidentsListResponse,
  type IncidentWeekStats,
  incidentPolicyResponseSchema,
  incidentSchema,
  incidentsListResponseSchema,
  incidentWeekStatsSchema,
  type ResolveIncidentRequest,
} from '@nodeservice/shared';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';

import { api, request } from '@/lib/api';

export type IncidentsFilter = 'all' | 'open' | 'resolved';
export interface IncidentsListParams {
  /** Открыт не раньше этого момента (ISO) — например, «за последние 7 дней» для полосы итога. */
  openedFrom?: string;
  /** Только «Все»/«Решённые» режутся постранично — «Открытые» сервер всё равно вернёт целиком. */
  page?: number;
  pageSize?: number;
  /** С какой строки начать (с нуля) — вместо номера страницы: страницы реестра разной длины. */
  offset?: number;
}

export const incidentsApi = {
  list: (
    status: IncidentsFilter,
    params?: IncidentsListParams,
    signal?: AbortSignal,
  ): Promise<IncidentsListResponse> => {
    const q = new URLSearchParams({ status });
    if (params?.openedFrom) q.set('openedFrom', params.openedFrom);
    if (params?.page) q.set('page', String(params.page));
    if (params?.pageSize) q.set('pageSize', String(params.pageSize));
    if (params?.offset !== undefined) q.set('offset', String(params.offset));
    return api.get(`/incidents?${q}`, incidentsListResponseSchema, signal);
  },
  weekStats: (signal?: AbortSignal): Promise<IncidentWeekStats> =>
    api.get('/incidents/week-stats', incidentWeekStatsSchema, signal),
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
  // Без params — тот же ключ, что и раньше (важно: useOpenIncidentsCount опирается на него для кэша).
  list: (status: IncidentsFilter, params?: IncidentsListParams) =>
    params ? (['incidents', 'list', status, params] as const) : (['incidents', 'list', status] as const),
  item: (id: string) => ['incidents', 'item', id] as const,
  policy: ['incidents', 'policy'] as const,
  weekStats: ['incidents', 'week-stats'] as const,
};

/** Идёт ли по какому-то инциденту попытка или разбор Джарвиса — тогда данные перечитываются часто. */
export const hasRunningAttempt = (items: Incident[] | undefined): boolean =>
  Boolean(
    items?.some((i) => i.analysis?.status === 'running' || i.attempts.some((a) => a.status === 'running')),
  );

export function useIncidents(status: IncidentsFilter, params?: IncidentsListParams & { enabled?: boolean }) {
  const { enabled = true, ...listParams } = params ?? {};
  const hasParams = Object.values(listParams).some((v) => v !== undefined);
  return useQuery({
    queryKey: incidentsKeys.list(status, hasParams ? listParams : undefined),
    queryFn: ({ signal }) => incidentsApi.list(status, hasParams ? listParams : undefined, signal),
    enabled,
    // Листание и смена размера страницы (реестр подстраивается под высоту окна): прежняя страница остаётся
    // на экране, пока не пришла новая, — без мигания заглушкой.
    ...(hasParams ? { placeholderData: keepPreviousData } : {}),
    // Живой поток приносит изменения сразу; опрос — страховка. Пока идёт попытка — чаще.
    refetchInterval: (q) => (hasRunningAttempt(q.state.data?.items) ? 2_000 : 60_000),
  });
}

/** Полоса «за 7 дней»: сервер отдаёт готовые цифры — без выгрузки самих инцидентов, поэтому быстро. */
export function useIncidentWeekStats() {
  return useQuery({
    queryKey: incidentsKeys.weekStats,
    queryFn: ({ signal }) => incidentsApi.weekStats(signal),
    refetchInterval: 60_000,
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
    queryFn: ({ signal }) => incidentsApi.list('open', undefined, signal),
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
/**
 * Удаление всех решённых: из кэша списков они убираются сразу. Иначе, пока идёт перечитывание, страница из
 * кэша показывала бы удалённые инциденты как существующие — со ссылками на то, чего уже нет.
 */
export function useDeleteResolvedIncidents() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: incidentsApi.removeResolved,
    onSuccess: () => {
      // Страницы решённых, которых сейчас нет на экране, из кэша убираем совсем: переписанные в «пусто»,
      // они потом подставились бы под тем же ключом, когда решённые появятся снова.
      qc.removeQueries({ queryKey: incidentsKeys.list('resolved'), type: 'inactive' });
      qc.setQueriesData<IncidentsListResponse>({ queryKey: incidentsKeys.lists }, (cur) => {
        if (!cur) return cur;
        const items = cur.items.filter((i) => i.status !== 'resolved');
        if (items.length === cur.items.length) return cur;
        // Список из одних решённых пуст целиком; в смешанном счётчики поправит перечитывание.
        return items.length === 0 ? { ...cur, items, page: 1, total: 0, totalPages: 0 } : { ...cur, items };
      });
      void qc.invalidateQueries({ queryKey: incidentsKeys.all });
    },
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
