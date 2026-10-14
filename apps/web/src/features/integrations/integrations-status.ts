import { integrationsStatusSchema } from '@nodeservice/shared';
import { useQuery } from '@tanstack/react-query';

import { api } from '@/lib/api';

/** Подключённые интеграции и их баланс: тот же запрос, что у страниц интеграций, из кэша. */
export function useIntegrationsStatus() {
  return useQuery({
    queryKey: ['integrations'],
    queryFn: ({ signal }) => api.get('/integrations', integrationsStatusSchema, signal),
    staleTime: 30_000,
  });
}
