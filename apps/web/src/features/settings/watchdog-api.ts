import {
  type WatchdogStatus,
  type WatchdogTestResponse,
  watchdogStatusSchema,
  watchdogTestResponseSchema,
} from '@nodeservice/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { withStepUp } from '@/features/security/step-up';
import { api } from '@/lib/api';

export const WATCHDOG_KEY = ['settings', 'watchdog'] as const;

/** «Настройки → Уведомления → Сторож панели»: где стоит сторож и можно ли его поставить. */
export function useWatchdog() {
  return useQuery({
    queryKey: WATCHDOG_KEY,
    queryFn: ({ signal }) => api.get('/settings/watchdog', watchdogStatusSchema, signal),
  });
}

/** Поставить (или поставить заново): панель заходит на сервер по SSH — как установка агента, с паролем. */
export function useInstallWatchdog() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (serverId: string): Promise<WatchdogStatus> =>
      withStepUp(() => api.post('/settings/watchdog/install', { serverId }, watchdogStatusSchema)),
    onSuccess: (s) => qc.setQueryData(WATCHDOG_KEY, s),
  });
}

export function useRemoveWatchdog() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (): Promise<WatchdogStatus> =>
      api.post('/settings/watchdog/remove', {}, watchdogStatusSchema),
    onSuccess: (s) => qc.setQueryData(WATCHDOG_KEY, s),
  });
}

export function useTestWatchdog() {
  return useMutation({
    mutationFn: (): Promise<WatchdogTestResponse> =>
      api.post('/settings/watchdog/test', {}, watchdogTestResponseSchema),
  });
}
