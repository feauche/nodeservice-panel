import {
  type AssistantSettingsUpdate,
  type AssistantStatus,
  assistantStatusSchema,
} from '@nodeservice/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { api } from '@/lib/api';
import { assistantKeys } from './assistant-api';

export function useAssistantSettings() {
  return useQuery({
    queryKey: ['settings', 'assistant'] as const,
    queryFn: ({ signal }) => api.get('/settings/assistant', assistantStatusSchema, signal),
  });
}

export function useUpdateAssistantSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: AssistantSettingsUpdate): Promise<AssistantStatus> =>
      api.put('/settings/assistant', body, assistantStatusSchema),
    onSuccess: (data) => {
      qc.setQueryData(['settings', 'assistant'], data);
      qc.setQueryData(assistantKeys.status, data);
    },
  });
}
