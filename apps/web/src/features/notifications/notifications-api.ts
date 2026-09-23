import {
  type CreateNotificationRequest,
  type Notification,
  type NotificationsResponse,
  notificationSchema,
  notificationsResponseSchema,
} from '@nodeservice/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { z } from 'zod';

import { incidentsKeys } from '@/features/incidents/incidents-api';
import { API_BASE, api, request } from '@/lib/api';

export const notificationsApi = {
  list: (signal?: AbortSignal): Promise<NotificationsResponse> =>
    api.get('/notifications', notificationsResponseSchema, signal),
  create: (body: CreateNotificationRequest): Promise<Notification> =>
    api.post('/notifications', body, notificationSchema),
  readAll: (): Promise<{ unread: number }> =>
    api.post('/notifications/read-all', {}, z.object({ unread: z.number().int() })),
  remove: (id: string): Promise<void> => request(`/notifications/${id}`, { method: 'DELETE' }),
  clear: (): Promise<void> => request('/notifications', { method: 'DELETE' }),
};

export const notificationsKeys = { list: ['notifications'] as const };

export function useNotifications(enabled = true) {
  return useQuery({
    queryKey: notificationsKeys.list,
    queryFn: ({ signal }) => notificationsApi.list(signal),
    refetchInterval: 30_000,
    enabled,
  });
}

function useInvalidate() {
  const qc = useQueryClient();
  return () => void qc.invalidateQueries({ queryKey: notificationsKeys.list });
}

export function useReadAllNotifications() {
  const inv = useInvalidate();
  return useMutation({ mutationFn: notificationsApi.readAll, onSuccess: inv });
}
export function useDeleteNotification() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: notificationsApi.remove,
    // Убираем из списка сразу, не дожидаясь перечитывания.
    onMutate: (id) => {
      qc.setQueryData<NotificationsResponse>(notificationsKeys.list, (cur) =>
        cur
          ? {
              ...cur,
              items: cur.items.filter((n) => n.id !== id),
              total: Math.max(0, cur.total - 1),
              unread: cur.items.find((n) => n.id === id)?.readAt ? cur.unread : Math.max(0, cur.unread - 1),
            }
          : cur,
      );
    },
    onSettled: () => void qc.invalidateQueries({ queryKey: notificationsKeys.list }),
  });
}
/**
 * Живой поток колокольчика: на каждое новое уведомление перечитываем список и инциденты —
 * инцидент появляется сразу, а не через опрос. В тестах и моках EventSource нет — тихо выключено.
 */
export function useNotificationsStream(enabled = true): void {
  const qc = useQueryClient();
  useEffect(() => {
    if (!enabled || typeof EventSource === 'undefined' || import.meta.env.VITE_MOCK === '1') return;
    const es = new EventSource(`${API_BASE}/notifications/stream`, { withCredentials: true });
    es.addEventListener('notification', () => {
      void qc.invalidateQueries({ queryKey: notificationsKeys.list });
      void qc.invalidateQueries({ queryKey: incidentsKeys.all });
    });
    return () => es.close();
  }, [enabled, qc]);
}

export function useClearNotifications() {
  const inv = useInvalidate();
  return useMutation({ mutationFn: notificationsApi.clear, onSuccess: inv });
}
