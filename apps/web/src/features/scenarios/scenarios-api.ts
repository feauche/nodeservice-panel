import {
  type RunTone,
  type Scenario,
  type ScenarioDisabledHosts,
  scenarioDisabledHostsSchema,
  scenarioHostsRestoreSchema,
  scenarioJournalSchema,
  scenarioOverviewSchema,
  scenarioRunsSchema,
  scenariosSchema,
} from '@nodeservice/shared';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
export function useScenarios() {
  return useQuery({
    queryKey: ['scenarios'],
    queryFn: ({ signal }) => api.get('/scenarios', scenariosSchema, signal),
    staleTime: 15000,
  });
}
/**
 * Host, которые сейчас держат отключёнными сценарии, по нодам — для метки «Host отключён» и блока в окне ноды.
 * Обновляется с тем же шагом, что список нод.
 */
export function useDisabledHosts() {
  return useQuery({
    queryKey: ['scenarios', 'disabled'],
    queryFn: ({ signal }) => api.get('/scenarios/disabled', scenarioDisabledHostsSchema, signal),
    refetchInterval: 15_000,
    staleTime: 10_000,
  });
}
/** Отключённые сценариями Host одной ноды или null. */
export function useNodeDisabledHosts(nodeUuid: string): ScenarioDisabledHosts['items'][number] | null {
  return useDisabledHosts().data?.items.find((i) => i.nodeUuid === nodeUuid) ?? null;
}
/** «Вернуть Host сейчас» из окна ноды. */
export function useRestoreHostsNow(nodeUuid: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.post(`/scenarios/disabled/${nodeUuid}/restore`, {}, scenarioHostsRestoreSchema),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ['scenarios'] });
    },
  });
}
export function useSaveScenarios() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (items: Scenario[]) => api.put('/scenarios', { items }, scenariosSchema),
    onSuccess: (data) => {
      qc.setQueryData(['scenarios'], data);
      // Включили или выключили сценарий — сводка («включено 2 из 3») обновляется сразу.
      void qc.invalidateQueries({ queryKey: ['scenarios', 'overview'] });
    },
  });
}
/** Журнал срабатываний: свежие первыми; обновляется раз в 15 секунд, пока страница открыта. */
export function useScenarioRuns() {
  return useQuery({
    queryKey: ['scenarios', 'runs'],
    queryFn: ({ signal }) => api.get('/scenarios/runs', scenarioRunsSchema, signal),
    refetchInterval: 15_000,
  });
}

/** Сводка для списка: плитки сверху и по строке на сценарий (последнее срабатывание, числа, полоска). */
export function useScenarioOverview() {
  return useQuery({
    queryKey: ['scenarios', 'overview'],
    queryFn: ({ signal }) => api.get('/scenarios/overview', scenarioOverviewSchema, signal),
    refetchInterval: 15_000,
  });
}

export type JournalPeriod = '24h' | '7d' | '30d';
export type JournalFilter = { rule?: string; node?: string; tone: RunTone[]; period: JournalPeriod };
/**
 * Журнал срабатываний порциями по 20: «Показать ещё» догружает следующую по курсору. Обновляется раз в 15 секунд —
 * порции перечитываются по порядку от первой, так что новые срабатывания сверху ничего не теряют и не повторяют.
 */
export function useScenarioJournal(filter: JournalFilter, enabled = true) {
  return useInfiniteQuery({
    queryKey: ['scenarios', 'journal', filter],
    queryFn: ({ pageParam, signal }) => {
      const p = new URLSearchParams({ period: filter.period, limit: '20' });
      if (filter.rule) p.set('rule', filter.rule);
      if (filter.node) p.set('node', filter.node);
      if (filter.tone.length) p.set('tone', filter.tone.join(','));
      if (pageParam) p.set('before', pageParam);
      return api.get(`/scenarios/journal?${p}`, scenarioJournalSchema, signal);
    },
    initialPageParam: '',
    getNextPageParam: (last) => last.next ?? undefined,
    refetchInterval: 15_000,
    enabled,
  });
}
