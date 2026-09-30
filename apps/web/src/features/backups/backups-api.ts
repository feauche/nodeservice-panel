import {
  type BackupInspect,
  type BackupItem,
  type BackupSettings,
  type BackupSettingsUpdate,
  backupInspectSchema,
  backupItemSchema,
  backupPathCheckSchema,
  backupSettingsSchema,
  backupsResponseSchema,
} from '@nodeservice/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';

import { withStepUp } from '@/features/security/step-up';
import { API_BASE, ApiError, api, CSRF_HEADER, getCsrfToken, request } from '@/lib/api';

const okSchema = z.object({ ok: z.literal(true) });
const testSchema = z.object({ ok: z.boolean(), detail: z.string() });

/** /api/backups — по контракту packages/shared/src/backups.ts. */
export const backupsApi = {
  list: (signal?: AbortSignal) => api.get('/backups', backupsResponseSchema, signal),
  settings: (signal?: AbortSignal) => api.get('/backups/settings', backupSettingsSchema, signal),
  updateSettings: (body: BackupSettingsUpdate): Promise<BackupSettings> =>
    api.put('/backups/settings', body, backupSettingsSchema),
  run: (sendTelegram: boolean) => api.post('/backups/run', { sendTelegram }, okSchema),
  checkPaths: (paths: string[]) => api.post('/backups/check-paths', { paths }, backupPathCheckSchema),
  testChat: (url: string | null) => api.post('/backups/test-chat', { url }, testSchema),
  inspect: (name: string, password?: string): Promise<BackupInspect> =>
    api.post(
      `/backups/${encodeURIComponent(name)}/inspect`,
      password ? { password } : {},
      backupInspectSchema,
    ),
  restore: (name: string, body: { password?: string; confirm: string }) =>
    api.post(`/backups/${encodeURIComponent(name)}/restore`, body, okSchema),
  remove: (name: string): Promise<void> =>
    request(`/backups/${encodeURIComponent(name)}`, { method: 'DELETE' }),
  downloadUrl: (name: string) => `${API_BASE}/backups/${encodeURIComponent(name)}/download`,
};

/**
 * Загрузка архива с компьютера: тело — сам файл (до 2 ГБ), поэтому XHR — ради полосы хода.
 * Ошибка приходит как обычная problem+json.
 */
export async function uploadBackup(file: File, onProgress: (share: number) => void): Promise<BackupItem> {
  const token = await getCsrfToken();
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${API_BASE}/backups/upload`);
    xhr.withCredentials = true;
    xhr.setRequestHeader('content-type', 'application/octet-stream');
    xhr.setRequestHeader('x-file-name', encodeURIComponent(file.name));
    xhr.setRequestHeader(CSRF_HEADER, token);
    xhr.setRequestHeader('accept', 'application/json, application/problem+json');
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(e.loaded / e.total);
    };
    xhr.onerror = () =>
      reject(
        new ApiError({ type: 'about:blank', title: 'Нет связи с панелью — файл не загрузился', status: 0 }),
      );
    xhr.onload = () => {
      let body: unknown = null;
      try {
        body = JSON.parse(xhr.responseText);
      } catch {
        /* не JSON — ниже общая ошибка */
      }
      if (xhr.status >= 200 && xhr.status < 300) {
        const parsed = backupItemSchema.safeParse(body);
        if (parsed.success) resolve(parsed.data);
        else reject(new ApiError({ type: 'about:blank', title: 'Сервер вернул не то', status: xhr.status }));
        return;
      }
      const p = (body ?? {}) as { type?: string; title?: string; detail?: string };
      reject(
        new ApiError({
          type: p.type ?? 'about:blank',
          title: p.title ?? 'Файл не загрузился',
          status: xhr.status,
          ...(p.detail ? { detail: p.detail } : {}),
        }),
      );
    };
    xhr.send(file);
  });
}

export const backupsKeys = {
  list: ['backups', 'list'] as const,
  settings: ['backups', 'settings'] as const,
};

/** Список и ход копии: пока что-то делается — опрос раз в секунду, иначе раз в 30 секунд. */
export function useBackups() {
  return useQuery({
    queryKey: backupsKeys.list,
    queryFn: ({ signal }) => backupsApi.list(signal),
    refetchInterval: (q) => (q.state.data?.run.stage ? 1000 : 30_000),
  });
}

export function useBackupSettings() {
  return useQuery({ queryKey: backupsKeys.settings, queryFn: ({ signal }) => backupsApi.settings(signal) });
}

export function useUpdateBackupSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: backupsApi.updateSettings,
    onSuccess: (data) => {
      qc.setQueryData(backupsKeys.settings, data);
      void qc.invalidateQueries({ queryKey: backupsKeys.list });
    },
  });
}

/**
 * Запуск копии. Ответ — отметка списка копий, который лежал в кэше, когда сервер принял запуск: список,
 * перечитанный после неё, уже знает об этой копии. По прежнему окно не судит, чем кончилось, — он ещё про
 * «до». Перечитывание ниже отменяет запрос списка, который был в пути: опоздавший ответ за свежий не сойдёт.
 */
export function useRunBackup() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (sendTelegram: boolean) => {
      await backupsApi.run(sendTelegram);
      return qc.getQueryState(backupsKeys.list)?.dataUpdatedAt ?? 0;
    },
    onSettled: () => void qc.invalidateQueries({ queryKey: backupsKeys.list }),
  });
}

export function useDeleteBackup() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (name: string) => withStepUp(() => backupsApi.remove(name)),
    onSettled: () => void qc.invalidateQueries({ queryKey: backupsKeys.list }),
  });
}

export function useRestoreBackup() {
  return useMutation({
    mutationFn: ({ name, ...body }: { name: string; password?: string; confirm: string }) =>
      withStepUp(() => backupsApi.restore(name, body)),
  });
}
