import { type Scenario, scenarioRunsSchema, scenariosSchema } from '@nodeservice/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
export function useScenarios() {
  return useQuery({
    queryKey: ['scenarios'],
    queryFn: ({ signal }) => api.get('/scenarios', scenariosSchema, signal),
    staleTime: 15000,
  });
}
export function useSaveScenarios() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (items: Scenario[]) => api.put('/scenarios', { items }, scenariosSchema),
    onSuccess: (data) => qc.setQueryData(['scenarios'], data),
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
