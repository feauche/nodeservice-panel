import {
  AUDIT_SSE_EVENT,
  type AuditEntry,
  type AuditExportFormat,
  type AuditFilter,
  type AuditListQueryInput,
  type AuditListResponse,
  auditEntrySchema,
  auditListResponseSchema,
} from '@nodeservice/shared';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';

import { API_BASE, api } from '@/lib/api';

/** Фильтры → query-строка (массивы через запятую, пустое не шлём). */
export function auditQueryString(
  query: AuditListQueryInput | AuditFilter,
  extra: Record<string, string> = {},
) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries({ ...query, ...extra })) {
    if (value === undefined || value === null || value === '') continue;
    if (Array.isArray(value)) {
      if (value.length) params.set(key, value.join(','));
      continue;
    }
    params.set(key, String(value));
  }
  return params.toString();
}

export const auditApi = {
  list: (query: AuditListQueryInput, signal?: AbortSignal): Promise<AuditListResponse> =>
    api.get(`/audit?${auditQueryString(query)}`, auditListResponseSchema, signal),
};

export const auditListQuery = (query: AuditListQueryInput) => ({
  queryKey: ['audit', 'list', query] as const,
  queryFn: ({ signal }: { signal?: AbortSignal }) => auditApi.list(query, signal),
  placeholderData: keepPreviousData,
  // Журнал всегда свежий при открытии: кэш нужен только чтобы страницы не мигали при переключении.
  staleTime: 0,
  refetchOnMount: 'always' as const,
});

export function useAuditList(query: AuditListQueryInput) {
  return useQuery(auditListQuery(query));
}

/** Ссылка на выгрузку — обычный GET с cookie, браузер сам сохранит файл. */
export function auditExportUrl(filter: AuditFilter, format: AuditExportFormat): string {
  return `${API_BASE}/audit/export?${auditQueryString(filter, { format })}`;
}

export type AuditStreamStatus = 'off' | 'connecting' | 'live' | 'reconnecting' | 'waiting';

export interface AuditStreamState {
  status: AuditStreamStatus;
  /** Когда следующая попытка подключиться (status 'waiting'), мс по часам браузера. */
  retryAt: number | null;
  /** Подключиться сейчас, не дожидаясь паузы. */
  retry: () => void;
}

/** Паузы между попытками, когда браузер сам сдался: 2 с, 5 с, 10 с, дальше раз в 30 с. */
const RETRY_STEPS_MS = [2_000, 5_000, 10_000, 30_000];

/**
 * Live-лента через EventSource. При коротком обрыве браузер переподключается сам и шлёт Last-Event-ID —
 * сервер догоняет пропущенное. Если сервер ответил не 200 (например, 502, пока панель перезапускается),
 * браузер закрывает соединение навсегда — тогда переподключаемся сами с растущей паузой, а после
 * восстановления зовём onResync: новое соединение пропущенное не догоняет, список надо перечитать.
 * Записи, не прошедшие контракт, молча пропускаются.
 */
export function useAuditStream(
  enabled: boolean,
  onEntry: (entry: AuditEntry) => void,
  onResync?: () => void,
): AuditStreamState {
  const [status, setStatus] = useState<AuditStreamStatus>('off');
  const [retryAt, setRetryAt] = useState<number | null>(null);
  const [attempt, setAttempt] = useState(0);
  const handler = useRef(onEntry);
  handler.current = onEntry;
  const resync = useRef(onResync);
  resync.current = onResync;
  const failures = useRef(0);
  const lost = useRef(false);

  // biome-ignore lint/correctness/useExhaustiveDependencies: attempt — повод открыть соединение заново
  useEffect(() => {
    if (!enabled || typeof EventSource === 'undefined') {
      setStatus('off');
      setRetryAt(null);
      return;
    }
    setStatus('connecting');
    const es = new EventSource(`${API_BASE}/audit/stream`, { withCredentials: true });
    let timer: ReturnType<typeof setTimeout> | undefined;
    es.onopen = () => {
      setStatus('live');
      setRetryAt(null);
      failures.current = 0;
      if (lost.current) {
        lost.current = false;
        resync.current?.();
      }
    };
    es.onerror = () => {
      if (es.readyState !== EventSource.CLOSED) {
        setStatus('reconnecting');
        return;
      }
      es.close();
      lost.current = true;
      const delay = RETRY_STEPS_MS[Math.min(failures.current, RETRY_STEPS_MS.length - 1)] ?? 30_000;
      failures.current += 1;
      setStatus('waiting');
      setRetryAt(Date.now() + delay);
      timer = setTimeout(() => setAttempt((n) => n + 1), delay);
    };
    es.addEventListener(AUDIT_SSE_EVENT, (ev) => {
      try {
        const parsed = auditEntrySchema.safeParse(JSON.parse((ev as MessageEvent<string>).data));
        if (parsed.success) handler.current(parsed.data);
      } catch {
        /* мусор в потоке — игнорируем */
      }
    });
    return () => {
      clearTimeout(timer);
      es.close();
      setStatus('off');
    };
  }, [enabled, attempt]);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  return { status, retryAt, retry };
}
