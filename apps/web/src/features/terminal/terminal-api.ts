import {
  type TerminalSessionDetail,
  terminalSessionDetailSchema,
  terminalSessionsResponseSchema,
} from '@nodeservice/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import { api } from '@/lib/api';

export const terminalKeys = {
  sessions: (serverId: string, q = '', since = '') => ['terminal', 'sessions', serverId, q, since] as const,
  session: (serverId: string, id: string) => ['terminal', 'session', serverId, id] as const,
};

/**
 * Последние сессии терминала сервера (без записи вывода). С `q` — только сессии, где строка
 * встречается в записи, у каждой `matches`; `since` — не раньше этой даты (ISO).
 */
export function useTerminalSessions(serverId: string, opts: { q?: string; since?: string } = {}) {
  const q = opts.q?.trim() ?? '';
  const since = opts.since ?? '';
  return useQuery({
    queryKey: terminalKeys.sessions(serverId, q, since),
    queryFn: ({ signal }) => {
      const p = new URLSearchParams({ limit: '50' });
      if (q) p.set('q', q);
      if (since) p.set('since', since);
      return api.get(`/servers/${serverId}/terminal/sessions?${p}`, terminalSessionsResponseSchema, signal);
    },
    // Пока пользователь печатает, старый список не мигает скелетоном.
    placeholderData: (prev) => prev,
    refetchInterval: 15_000,
  });
}

/**
 * Одна сессия с записью вывода. Живая сессия догружается по смещению: с сервера приходит только
 * новый хвост, в кэше он приклеивается к уже полученному тексту.
 */
export function useTerminalSession(serverId: string, id: string | null) {
  const qc = useQueryClient();
  const key = terminalKeys.session(serverId, id ?? '');
  return useQuery({
    queryKey: key,
    queryFn: async ({ signal }) => {
      const prev = qc.getQueryData<TerminalSessionDetail>(key);
      const offset = prev?.transcript.length ?? 0;
      const res = await api.get(
        `/servers/${serverId}/terminal/sessions/${id}?offset=${offset}`,
        terminalSessionDetailSchema,
        signal,
      );
      // Запись могли усечь/пересоздать — если сервер знает меньше, чем у нас, начинаем заново.
      if (!prev || res.length < offset) {
        return offset === 0 ? res : { ...res, transcript: '', offset: 0 };
      }
      return { ...res, transcript: prev.transcript + res.transcript, offset: 0 };
    },
    enabled: id !== null,
    staleTime: 10_000,
    // Открытая сессия дописывается — обновляем, пока не завершена.
    refetchInterval: (q) => (q.state.data && q.state.data.endedAt === null ? 3_000 : false),
  });
}
