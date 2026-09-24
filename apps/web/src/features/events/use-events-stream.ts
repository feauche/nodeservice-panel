import { useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';

import { incidentsKeys } from '@/features/incidents/incidents-api';
import { notificationsKeys } from '@/features/notifications/notifications-api';
import { API_BASE } from '@/lib/api';

/** События одного типа, пришедшие подряд, схлопываются в одно перечитывание. */
const COALESCE_MS = 250;

/**
 * Живой поток панели (SSE): сервер шлёт событие только при изменении, браузер перечитывает лишь
 * затронутое — серверы, инциденты или уведомления. Опрос остаётся страховкой раз в минуту.
 * EventSource сам переподключается при обрыве. В тестах и моках потока нет — тихо выключено.
 */
export function useEventsStream(enabled = true): void {
  const qc = useQueryClient();
  useEffect(() => {
    if (!enabled || typeof EventSource === 'undefined' || import.meta.env.VITE_MOCK === '1') return;
    const es = new EventSource(`${API_BASE}/events/stream`, { withCredentials: true });
    const timers = new Map<string, ReturnType<typeof setTimeout>>();
    const later = (key: string, fn: () => void) => {
      const t = timers.get(key);
      if (t) clearTimeout(t);
      timers.set(
        key,
        setTimeout(() => {
          timers.delete(key);
          fn();
        }, COALESCE_MS),
      );
    };
    es.addEventListener('notification', () =>
      later('notification', () => void qc.invalidateQueries({ queryKey: notificationsKeys.list })),
    );
    es.addEventListener('server', () =>
      later('server', () => {
        void qc.invalidateQueries({ queryKey: ['servers'] });
        void qc.invalidateQueries({ queryKey: ['metrics', 'overview'] });
      }),
    );
    es.addEventListener('incident', () =>
      later('incident', () => void qc.invalidateQueries({ queryKey: incidentsKeys.all })),
    );
    return () => {
      for (const t of timers.values()) clearTimeout(t);
      es.close();
    };
  }, [enabled, qc]);
}
