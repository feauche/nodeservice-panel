import {
  REMNAWAVE_SYNC_INTERVAL_MIN,
  type RemnawaveConnectRequest,
  type RemnawaveStatus,
  type RemnawaveTopology,
  type RemnawaveVpnProbeRequest,
  type RemnawaveVpnProbeStatus,
  remnawaveStatusSchema,
  remnawaveTopologySchema,
  remnawaveVpnProbeStatusSchema,
} from '@nodeservice/shared';
import { queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, request } from '@/lib/api';

/** /api/remnawave — только чтение (J4), контракт packages/shared/src/remnawave.ts. */
export const remnawaveApi = {
  status: (signal?: AbortSignal): Promise<RemnawaveStatus> =>
    api.get('/remnawave/status', remnawaveStatusSchema, signal),
  topology: (signal?: AbortSignal): Promise<RemnawaveTopology> =>
    api.get('/remnawave/topology', remnawaveTopologySchema, signal),
  connect: (body: RemnawaveConnectRequest): Promise<RemnawaveStatus> =>
    api.post('/remnawave/connect', body, remnawaveStatusSchema),
  refresh: (): Promise<RemnawaveStatus> => api.post('/remnawave/refresh', {}, remnawaveStatusSchema),
  disconnect: (): Promise<void> => request('/remnawave', { method: 'DELETE' }),
  configureVpnProbe: (body: RemnawaveVpnProbeRequest): Promise<RemnawaveVpnProbeStatus> =>
    api.put('/remnawave/vpn-probe', body, remnawaveVpnProbeStatusSchema),
  clearVpnProbe: (): Promise<void> => request('/remnawave/vpn-probe', { method: 'DELETE' }),
};

export const remnawaveKeys = {
  status: ['remnawave', 'status'] as const,
  topology: ['remnawave', 'topology'] as const,
};

export const remnawaveStatusQuery = queryOptions({
  queryKey: remnawaveKeys.status,
  queryFn: ({ signal }) => remnawaveApi.status(signal),
  staleTime: 15_000,
  // Панель перечитывает Remnawave раз в минуту, а события о ней в живом потоке нет: без своего опроса
  // пилюли на карточках показывали бы то, что было при открытии страницы, пока не переключишь вкладку.
  refetchInterval: REMNAWAVE_SYNC_INTERVAL_MIN * 60_000,
});

/** Статус подключения — читают и страница подключения, и плитка на «Обзоре», и пилюля на карточке сервера. */
export function useRemnawaveStatus() {
  return useQuery(remnawaveStatusQuery);
}

export function useRemnawaveTopology(enabled = true) {
  return useQuery({
    queryKey: remnawaveKeys.topology,
    queryFn: ({ signal }) => remnawaveApi.topology(signal),
    enabled,
    staleTime: 60_000,
  });
}

export function useConnectRemnawave() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: remnawaveApi.connect,
    onSuccess: (status) => {
      qc.setQueryData(remnawaveKeys.status, status);
      void qc.invalidateQueries({ queryKey: remnawaveKeys.topology });
    },
  });
}

export function useRefreshRemnawave() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: remnawaveApi.refresh,
    onSuccess: (status) => {
      qc.setQueryData(remnawaveKeys.status, status);
      void qc.invalidateQueries({ queryKey: remnawaveKeys.topology });
    },
  });
}

export function useDisconnectRemnawave() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: remnawaveApi.disconnect,
    onSuccess: () =>
      qc.setQueryData(remnawaveKeys.status, {
        connected: false,
        domain: null,
        checkedAt: null,
        error: null,
        stats: null,
        nodes: [],
        cert: null,
        vpnProbeConfigured: false,
        vpnProbeRoutes: null,
        vpnProbeRouteDetails: [],
      } satisfies RemnawaveStatus),
  });
}

export function useConfigureVpnProbe() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: remnawaveApi.configureVpnProbe,
    onSuccess: (probe) =>
      qc.setQueryData<RemnawaveStatus>(remnawaveKeys.status, (status) =>
        status
          ? {
              ...status,
              vpnProbeConfigured: probe.configured,
              vpnProbeRoutes: probe.routes,
              vpnProbeRouteDetails: probe.routeDetails,
            }
          : status,
      ),
  });
}

export function useClearVpnProbe() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: remnawaveApi.clearVpnProbe,
    onSuccess: () =>
      qc.setQueryData<RemnawaveStatus>(remnawaveKeys.status, (status) =>
        status
          ? { ...status, vpnProbeConfigured: false, vpnProbeRoutes: null, vpnProbeRouteDetails: [] }
          : status,
      ),
  });
}
