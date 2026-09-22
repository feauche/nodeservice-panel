import {
  type MaintenanceKind,
  type MaintenanceRun,
  type MaintenanceState,
  maintenanceRunSchema,
  maintenanceStateSchema,
} from '@nodeservice/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { api } from '@/lib/api';

export const maintenanceKeys = {
  state: (serverId: string) => ['maintenance', serverId] as const,
};

/**
 * Обслуживание сервера: чек-лист, идущий и последний запуск. Пока что-то идёт — опрашиваем часто,
 * чтобы шаги и лог двигались на глазах; в покое — редко (проверка раз в сутки).
 */
export function useMaintenance(serverId: string) {
  return useQuery({
    queryKey: maintenanceKeys.state(serverId),
    queryFn: ({ signal }) => api.get(`/servers/${serverId}/maintenance`, maintenanceStateSchema, signal),
    refetchInterval: (q) => (q.state.data?.running ? 1_500 : 30_000),
  });
}

/** Запуск проверки или действия; после ответа сразу подтягиваем состояние с идущим запуском. */
export function useStartMaintenance(serverId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (kind: MaintenanceKind): Promise<MaintenanceRun> =>
      api.post(`/servers/${serverId}/maintenance/runs`, { kind }, maintenanceRunSchema),
    onSuccess: (run) => {
      qc.setQueryData<MaintenanceState>(maintenanceKeys.state(serverId), (old) =>
        old ? { ...old, running: run } : old,
      );
      void qc.invalidateQueries({ queryKey: maintenanceKeys.state(serverId) });
    },
  });
}
