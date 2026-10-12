import { type Scenario, scenariosSchema } from '@nodeservice/shared';
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
