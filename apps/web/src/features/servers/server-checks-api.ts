import {
  type ServerCheckKey,
  type ServerCheckRun,
  type ServerChecksResponse,
  serverCheckRunSchema,
  serverChecksResponseSchema,
} from '@nodeservice/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { api } from '@/lib/api';

export const serverChecksKeys = {
  list: (serverId: string) => ['server-checks', serverId] as const,
};

/** Последний запуск каждой проверки. Пока что-то идёт — опрашиваем часто, чтобы вывод шёл на глазах. */
export function useServerChecks(serverId: string) {
  return useQuery({
    queryKey: serverChecksKeys.list(serverId),
    queryFn: ({ signal }) => api.get(`/servers/${serverId}/checks`, serverChecksResponseSchema, signal),
    refetchInterval: (q) => (q.state.data?.items.some((r) => r.status === 'running') ? 1_500 : 60_000),
  });
}

/** Подменить запуск той же проверки в кэше — чтобы строка сразу показала «Идёт» или пересказ. */
function putRun(
  old: ServerChecksResponse | undefined,
  run: ServerCheckRun,
): ServerChecksResponse | undefined {
  if (!old) return old;
  const rest = old.items.filter((r) => r.check !== run.check);
  return { ...old, items: [...rest, run] };
}

export function useRunServerCheck(serverId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ check, confirmHeavy }: { check: ServerCheckKey; confirmHeavy?: boolean }) =>
      api.post(`/servers/${serverId}/checks/${check}/run`, { confirmHeavy }, serverCheckRunSchema),
    onSuccess: (run) => {
      qc.setQueryData<ServerChecksResponse>(serverChecksKeys.list(serverId), (old) => putRun(old, run));
      void qc.invalidateQueries({ queryKey: serverChecksKeys.list(serverId) });
    },
  });
}

export function useExplainServerCheck(serverId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (runId: string) =>
      api.post(`/servers/${serverId}/checks/runs/${runId}/explain`, {}, serverCheckRunSchema),
    onSuccess: (run) => {
      qc.setQueryData<ServerChecksResponse>(serverChecksKeys.list(serverId), (old) => putRun(old, run));
    },
  });
}
