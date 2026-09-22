import { type OverviewMetricsResponse, overviewMetricsResponseSchema } from '@nodeservice/shared';
import { useQuery } from '@tanstack/react-query';

import { api } from '@/lib/api';

/** Сводка метрик парка: последние значения + спарклайны CPU. Обновляется раз в 15 с. */
export function useOverviewMetrics() {
  return useQuery({
    queryKey: ['metrics', 'overview'] as const,
    queryFn: ({ signal }): Promise<OverviewMetricsResponse> =>
      api.get('/metrics/overview', overviewMetricsResponseSchema, signal),
    refetchInterval: 15_000,
    refetchOnMount: 'always',
    staleTime: 10_000,
  });
}
