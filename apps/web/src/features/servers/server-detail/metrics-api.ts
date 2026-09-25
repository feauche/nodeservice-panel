import {
  type MetricRange,
  type ServerMetricsResponse,
  serverMetricsResponseSchema,
} from '@nodeservice/shared';
import { useQuery } from '@tanstack/react-query';

import { api } from '@/lib/api';

/** Серии метрик сервера из VictoriaMetrics; на «живом» диапазоне 1ч — автообновление. */
export function useServerMetrics(id: string, range: MetricRange, enabled = true) {
  return useQuery({
    enabled,
    queryKey: ['metrics', 'server', id, range] as const,
    queryFn: ({ signal }): Promise<ServerMetricsResponse> =>
      api.get(`/metrics/servers/${id}?range=${range}`, serverMetricsResponseSchema, signal),
    staleTime: 10_000,
    refetchInterval: range === '1h' ? 15_000 : false,
  });
}
