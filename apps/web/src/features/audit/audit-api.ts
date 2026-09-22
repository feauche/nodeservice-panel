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
import { useEffect, useRef, useState } from 'react';

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

export type AuditStreamStatus = 'off' | 'connecting' | 'live' | 'reconnecting';

/**
 * Live-лента через EventSource. Браузер сам переподключается и шлёт Last-Event-ID —
 * сервер догоняет пропущенное. Записи, не прошедшие контракт, молча пропускаются.
 */
export function useAuditStream(enabled: boolean, onEntry: (entry: AuditEntry) => void): AuditStreamStatus {
  const [status, setStatus] = useState<AuditStreamStatus>('off');
  const handler = useRef(onEntry);
  handler.current = onEntry;

  useEffect(() => {
    if (!enabled || typeof EventSource === 'undefined') {
      setStatus('off');
      return;
    }
    setStatus('connecting');
    const es = new EventSource(`${API_BASE}/audit/stream`, { withCredentials: true });
    es.onopen = () => setStatus('live');
    es.onerror = () => setStatus(es.readyState === EventSource.CLOSED ? 'off' : 'reconnecting');
    es.addEventListener(AUDIT_SSE_EVENT, (ev) => {
      try {
        const parsed = auditEntrySchema.safeParse(JSON.parse((ev as MessageEvent<string>).data));
        if (parsed.success) handler.current(parsed.data);
      } catch {
        /* мусор в потоке — игнорируем */
      }
    });
    return () => {
      es.close();
      setStatus('off');
    };
  }, [enabled]);

  return status;
}
