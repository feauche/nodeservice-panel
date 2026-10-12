import { nodeMetricHistorySchema } from '@nodeservice/shared';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';

export function useOnlineSummary(days: number, enabled = true) {
  return useQuery({
    queryKey: ['online-summary', days],
    enabled,
    queryFn: ({ signal }) => {
      const bounds = {
        from: new Date(Date.now() - Math.min(days, 30) * 86400000).toISOString(),
        to: new Date().toISOString(),
      };
      return api
        .get(
          `/nodes/metrics/history?${new URLSearchParams({ ...bounds, maxPoints: '60' })}`,
          nodeMetricHistorySchema,
          signal,
        )
        .then((data) => data.onlineSummary ?? null);
    },
    staleTime: 60000,
    refetchInterval: 60000,
  });
}
