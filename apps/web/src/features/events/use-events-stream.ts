import { useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';

import { incidentsKeys } from '@/features/incidents/incidents-api';
import { API_BASE } from '@/lib/api';

/** Ключ статуса нод (useNodes): строка списка, окно ноды, «Обзор». */
const NODES_STATUS_KEY = ['nodes', 'status'] as const;
/** События одного типа, пришедшие подряд, схлопываются в одно перечитывание. */
const COALESCE_MS = 250;
const RECONNECT_MAX_MS = 15_000;

/**
 * Живой поток панели (SSE): сервер шлёт событие только при изменении, браузер перечитывает лишь
 * затронутое — события и статус нод. Опрос остаётся страховкой.
 * Переподключение контролируем сами: после восстановления API перечитываем актуальное состояние,
 * поэтому открытая страница не остаётся со старыми данными. В тестовых моках поток выключен.
 */
export function useEventsStream(enabled = true): void {
  const qc = useQueryClient();
  useEffect(() => {
    if (!enabled || typeof EventSource === 'undefined' || import.meta.env.VITE_MOCK === '1') return;
    let es: EventSource | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let stopped = false;
    let opened = false;
    let reconnectAttempt = 0;
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
    const refreshAfterReconnect = () => {
      void qc.invalidateQueries({ queryKey: incidentsKeys.all });
      void qc.invalidateQueries({ queryKey: NODES_STATUS_KEY });
    };
    const connect = () => {
      if (stopped) return;
      const stream = new EventSource(`${API_BASE}/events/stream`, { withCredentials: true });
      es = stream;
      stream.onopen = () => {
        if (opened) refreshAfterReconnect();
        opened = true;
        reconnectAttempt = 0;
      };
      stream.onerror = () => {
        if (stopped || stream !== es) return;
        stream.close();
        es = null;
        const delay = Math.min(1_000 * 2 ** reconnectAttempt, RECONNECT_MAX_MS);
        reconnectAttempt += 1;
        reconnectTimer = setTimeout(connect, delay);
      };
      stream.addEventListener('incident', () =>
        later('incident', () => void qc.invalidateQueries({ queryKey: incidentsKeys.all })),
      );
      // Нода упала или поднялась в Remnawave — статус и цвет в списке меняются сразу, без ожидания опроса.
      stream.addEventListener('nodes', () =>
        later('nodes', () => void qc.invalidateQueries({ queryKey: NODES_STATUS_KEY })),
      );
    };
    const reconnectNow = () => {
      if (stopped || es) return;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      reconnectTimer = null;
      connect();
    };
    const onVisibility = () => {
      if (document.visibilityState === 'visible') reconnectNow();
    };
    connect();
    window.addEventListener('online', reconnectNow);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      stopped = true;
      window.removeEventListener('online', reconnectNow);
      document.removeEventListener('visibilitychange', onVisibility);
      for (const t of timers.values()) clearTimeout(t);
      if (reconnectTimer) clearTimeout(reconnectTimer);
      es?.close();
    };
  }, [enabled, qc]);
}
