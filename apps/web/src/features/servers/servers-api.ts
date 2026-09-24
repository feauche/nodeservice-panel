import {
  type CreateServerRequest,
  type EnrollmentTokenResponse,
  enrollmentTokenResponseSchema,
  type PanelKeyResponse,
  panelKeyResponseSchema,
  type Server,
  type ServersResponse,
  serverSchema,
  serversResponseSchema,
  type TestConnectionRequest,
  type TestConnectionResponse,
  testConnectionResponseSchema,
  type UpdateServerRequest,
} from '@nodeservice/shared';
import { queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { withStepUp } from '@/features/security/step-up';
import { api, request } from '@/lib/api';
import { toast } from '@/lib/notify';

/** /api/servers — строго по контракту packages/shared/src/servers.ts. */
export const serversApi = {
  list: (signal?: AbortSignal): Promise<ServersResponse> =>
    api.get('/servers', serversResponseSchema, signal),
  get: (id: string, signal?: AbortSignal): Promise<Server> => api.get(`/servers/${id}`, serverSchema, signal),
  panelKey: (signal?: AbortSignal): Promise<PanelKeyResponse> =>
    api.get('/servers/panel-key', panelKeyResponseSchema, signal),
  test: (body: TestConnectionRequest): Promise<TestConnectionResponse> =>
    api.post('/servers/test', body, testConnectionResponseSchema),
  create: (body: CreateServerRequest): Promise<Server> => api.post('/servers', body, serverSchema),
  update: (id: string, body: UpdateServerRequest): Promise<Server> =>
    request(`/servers/${id}`, { method: 'PATCH', body, schema: serverSchema }),
  remove: (id: string): Promise<void> => request(`/servers/${id}`, { method: 'DELETE' }),
  check: (id: string): Promise<Server> => api.post(`/servers/${id}/check`, {}, serverSchema),
  duplicate: (id: string): Promise<Server> => api.post(`/servers/${id}/duplicate`, {}, serverSchema),
  trustHostKey: (id: string, fingerprint: string): Promise<Server> =>
    api.post(`/servers/${id}/trust-host-key`, { fingerprint }, serverSchema),
  installAgent: (id: string): Promise<Server> => api.post(`/servers/${id}/agent/install`, {}, serverSchema),
  enrollmentToken: (id: string): Promise<EnrollmentTokenResponse> =>
    api.post(`/servers/${id}/enrollment-token`, {}, enrollmentTokenResponseSchema),
};

export const serversKeys = {
  all: ['servers'] as const,
  list: ['servers', 'list'] as const,
};

export const serversListQuery = queryOptions({
  queryKey: serversKeys.list,
  queryFn: ({ signal }) => serversApi.list(signal),
  staleTime: 15_000,
  refetchOnMount: 'always',
  // Агент ставится и подключается в фоне после добавления — статусы должны доезжать без действий пользователя.
  // Живой поток приносит изменения сразу; опрос — страховка на случай обрыва.
  refetchInterval: 60_000,
});

export function useServers() {
  return useQuery(serversListQuery);
}

export const serverQuery = (id: string) =>
  queryOptions({
    queryKey: ['servers', 'item', id] as const,
    queryFn: ({ signal }) => serversApi.get(id, signal),
    staleTime: 15_000,
    refetchOnMount: 'always' as const,
  });

/** Один сервер — для детальной страницы. */
export function useServer(id: string) {
  return useQuery(serverQuery(id));
}

function useApplyServer() {
  const qc = useQueryClient();
  return (server: Server) => {
    qc.setQueryData<ServersResponse>(serversKeys.list, (old) =>
      old ? { items: old.items.map((s) => (s.id === server.id ? server : s)) } : old,
    );
  };
}

export function useTestConnection() {
  return useMutation({ mutationFn: serversApi.test });
}

export function useCreateServer() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: serversApi.create,
    // Позицию новой записи знает сервер — перечитываем список.
    onSuccess: () => void qc.invalidateQueries({ queryKey: serversKeys.list }),
  });
}

export function useUpdateServer() {
  const apply = useApplyServer();
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: UpdateServerRequest }) => serversApi.update(id, patch),
    onSuccess: apply,
  });
}

export function useDeleteServer() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => withStepUp(() => serversApi.remove(id)),
    onSuccess: (_res, id) => {
      qc.setQueryData<ServersResponse>(serversKeys.list, (old) =>
        old ? { items: old.items.filter((s) => s.id !== id) } : old,
      );
    },
  });
}

/** «Дублировать»: сервер сам подбирает имя копии (-2, -3, …) и ставит её сразу после оригинала. */
export function useDuplicateServer() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: serversApi.duplicate,
    onSuccess: () => void qc.invalidateQueries({ queryKey: serversKeys.list }),
  });
}

/** Перетаскивание карточек: оптимистично меняем порядок, сервер подтверждает. */
export function useReorderServers() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (ids: string[]) => api.post('/servers/reorder', { ids }, serversResponseSchema),
    onMutate: async (ids) => {
      await qc.cancelQueries({ queryKey: serversKeys.list });
      const prev = qc.getQueryData<ServersResponse>(serversKeys.list);
      if (prev) {
        const byId = new Map(prev.items.map((s) => [s.id, s]));
        const picked = ids.map((id) => byId.get(id)).filter((s): s is Server => Boolean(s));
        const rest = prev.items.filter((s) => !ids.includes(s.id));
        qc.setQueryData<ServersResponse>(serversKeys.list, { items: [...picked, ...rest] });
      }
      return { prev };
    },
    onError: (_err, _ids, ctx) => {
      if (ctx?.prev) qc.setQueryData(serversKeys.list, ctx.prev);
      toast.error('Не получилось сохранить порядок — вернул как было.');
    },
    onSuccess: (res) => qc.setQueryData(serversKeys.list, res),
  });
}

export function useCheckServer() {
  const apply = useApplyServer();
  return useMutation({ mutationFn: serversApi.check, onSuccess: apply });
}

export interface CheckAllResult {
  ok: number;
  failed: number;
}

/** «Проверить все»: не больше четырёх SSH-проверок разом, ошибка одной не прерывает остальные. */
export function useCheckAllServers() {
  const apply = useApplyServer();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (ids: string[]): Promise<CheckAllResult> => {
      const queue = [...ids];
      let ok = 0;
      let failed = 0;
      const worker = async () => {
        for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
          try {
            apply(await serversApi.check(id));
            ok += 1;
          } catch {
            failed += 1;
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(4, ids.length) }, worker));
      return { ok, failed };
    },
    // Неудачные проверки тоже меняют серверное состояние (sshOk=false) — перечитываем список.
    onSettled: () => void qc.invalidateQueries({ queryKey: serversKeys.list }),
  });
}

export function useTrustHostKey() {
  const apply = useApplyServer();
  return useMutation({
    mutationFn: ({ id, fingerprint }: { id: string; fingerprint: string }) =>
      withStepUp(() => serversApi.trustHostKey(id, fingerprint)),
    onSuccess: apply,
  });
}

/** Кнопка «Установить по SSH»: панель сама выполняет установку, статус станет «Ожидает агента». */
export function useInstallAgent() {
  const apply = useApplyServer();
  return useMutation({
    mutationFn: (id: string) => withStepUp(() => serversApi.installAgent(id)),
    onSuccess: apply,
  });
}

export function useEnrollmentToken() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => withStepUp(() => serversApi.enrollmentToken(id)),
    onSuccess: () => void qc.invalidateQueries({ queryKey: serversKeys.all }),
  });
}
