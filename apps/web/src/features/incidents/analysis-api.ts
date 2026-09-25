import { type Incident, incidentSchema } from '@nodeservice/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';

import { api } from '@/lib/api';
import { incidentsKeys } from './incidents-api';

export const analysisApi = {
  /** Запуск разбора: сервер отвечает сразу, работа идёт в фоне, ход виден в самом инциденте. */
  run: (id: string): Promise<Incident> => api.post(`/incidents/${id}/analysis`, {}, incidentSchema),
  ask: (id: string, question: string): Promise<Incident> =>
    api.post(`/incidents/${id}/analysis/ask`, { question }, incidentSchema),
};

/** Ответ сразу кладём в кэш кейса: «идёт разбор» появляется без задержки на перечитывание. */
function useIncidentMutation<V>(fn: (v: V) => Promise<Incident>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: (inc) => {
      qc.setQueryData(incidentsKeys.item(inc.id), inc);
      void qc.invalidateQueries({ queryKey: incidentsKeys.lists });
    },
  });
}

export const useRunAnalysis = () => useIncidentMutation((id: string) => analysisApi.run(id));
export const useAskAnalysis = () =>
  useIncidentMutation(({ id, question }: { id: string; question: string }) => analysisApi.ask(id, question));
