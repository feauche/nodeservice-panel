import type { AssistantActivity } from '@nodeservice/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';

import { useActivityStore } from '@/features/assistant/activity';

import { incidentsKeys } from '@/features/incidents/incidents-api';
import { notificationsKeys } from '@/features/notifications/notifications-api';
import { API_BASE } from '@/lib/api';

/** События одного типа, пришедшие подряд, схлопываются в одно перечитывание. */
const COALESCE_MS = 250;
const RECONNECT_MAX_MS = 15_000;

/**
 * Живой поток панели (SSE): сервер шлёт событие только при изменении, браузер перечитывает лишь
 * затронутое — серверы, инциденты или уведомления. Опрос остаётся страховкой раз в минуту.
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
      void qc.invalidateQueries({ queryKey: ['servers'] });
      void qc.invalidateQueries({ queryKey: ['metrics', 'overview'] });
      void qc.invalidateQueries({ queryKey: incidentsKeys.all });
      void qc.invalidateQueries({ queryKey: notificationsKeys.list });
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
      stream.addEventListener('notification', () =>
        later('notification', () => void qc.invalidateQueries({ queryKey: notificationsKeys.list })),
      );
      stream.addEventListener('server', () =>
        later('server', () => {
          void qc.invalidateQueries({ queryKey: ['servers'] });
          void qc.invalidateQueries({ queryKey: ['metrics', 'overview'] });
        }),
      );
      // Переименовали сервер: новое имя нужно и в списках инцидентов, и в уведомлениях.
      stream.addEventListener('rename', () => later('rename', refreshAfterReconnect));
      // Джарвис делает что-то долгое (проверка сервера): живая строка в чате, без перечитывания.
      stream.addEventListener('assistant', (ev) => {
        try {
          const d = JSON.parse((ev as MessageEvent).data) as {
            conversationId: string;
            activity: AssistantActivity;
          };
          useActivityStore.getState().upsert(d.conversationId, d.activity);
        } catch {
          /* битое событие — просто пропускаем */
        }
      });
      stream.addEventListener('incident', () =>
        later('incident', () => void qc.invalidateQueries({ queryKey: incidentsKeys.all })),
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
