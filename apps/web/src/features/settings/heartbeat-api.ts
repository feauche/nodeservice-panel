import {
  type HeartbeatSettings,
  type HeartbeatTestRequest,
  type HeartbeatTestResponse,
  type HeartbeatView,
  heartbeatTestResponseSchema,
  heartbeatViewSchema,
} from '@nodeservice/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { api } from '@/lib/api';

const KEY = ['settings', 'heartbeat'] as const;
/** Сигнал уходит раз в минуту: перечитываем вдвое чаще, чтобы полоса «последний час» шла вживую. */
const REFRESH_MS = 30_000;
/** Адрес только что сохранён: первый сигнал сервер шлёт сразу — ждём его итог, а не полминуты. */
const FIRST_BEAT_MS = 3_000;

/** Сигнал «панель работает»: адрес сервиса проверки и что было с сигналом за последний час. */
export function useHeartbeat() {
  return useQuery({
    queryKey: KEY,
    queryFn: ({ signal }) => api.get('/settings/heartbeat', heartbeatViewSchema, signal),
    refetchInterval: (query) => {
      const v = query.state.data;
      return v?.url && !v.status.lastResult ? FIRST_BEAT_MS : REFRESH_MS;
    },
  });
}

export function useUpdateHeartbeat() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: HeartbeatSettings): Promise<HeartbeatView> =>
      api.put('/settings/heartbeat', body, heartbeatViewSchema),
    onSuccess: (v) => {
      qc.setQueryData(KEY, v);
    },
  });
}

export function useTestHeartbeat() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: HeartbeatTestRequest): Promise<HeartbeatTestResponse> =>
      api.post('/settings/heartbeat/test', body, heartbeatTestResponseSchema),
    // Проверка сохранённого адреса — настоящий сигнал: он попадает в полосу и «последний принятый».
    onSuccess: () => void qc.invalidateQueries({ queryKey: KEY }),
  });
}
