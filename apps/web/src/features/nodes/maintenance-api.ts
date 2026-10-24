import {
  type NodeMaintenanceStart,
  nodeMaintenanceEndSchema,
  nodeMaintenanceHostPreviewSchema,
  nodeMaintenanceSchema,
} from '@nodeservice/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, request } from '@/lib/api';

/** После включения и окончания перечитываем ноды (метка, счётчики) и события (открытые закрылись). */
function useRefresh() {
  const client = useQueryClient();
  return () => {
    void client.invalidateQueries({ queryKey: ['nodes', 'status'] });
    void client.invalidateQueries({ queryKey: ['incidents'] });
  };
}

/** Какие Host отключатся при включении обслуживания — только когда галочка «Отключить Host» включена. */
export function useMaintenanceHosts(uuid: string, enabled: boolean) {
  return useQuery({
    queryKey: ['nodes', 'maintenance-hosts', uuid],
    queryFn: ({ signal }) =>
      api.get(`/nodes/${uuid}/maintenance/hosts`, nodeMaintenanceHostPreviewSchema, signal),
    enabled,
    staleTime: 30_000,
  });
}

export function useStartMaintenance(uuid: string) {
  const refresh = useRefresh();
  return useMutation({
    mutationFn: (body: NodeMaintenanceStart) =>
      api.put(`/nodes/${uuid}/maintenance`, body, nodeMaintenanceSchema),
    onSuccess: refresh,
  });
}

export function useExtendMaintenance(uuid: string) {
  const refresh = useRefresh();
  return useMutation({
    mutationFn: () => api.post(`/nodes/${uuid}/maintenance/extend`, {}, nodeMaintenanceSchema),
    onSuccess: refresh,
  });
}

export function useEndMaintenance(uuid: string) {
  const refresh = useRefresh();
  return useMutation({
    mutationFn: () =>
      request(`/nodes/${uuid}/maintenance`, { method: 'DELETE', schema: nodeMaintenanceEndSchema }),
    onSuccess: refresh,
  });
}
