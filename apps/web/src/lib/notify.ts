import type { NotificationSeverity } from '@nodeservice/shared';
import { toast as sonner } from 'sonner';

import { notificationsApi, notificationsKeys } from '@/features/notifications/notifications-api';
import { queryClient } from '@/lib/query-client';

/**
 * Всплывашки панели. Тот же `toast`, что у sonner, но каждая success/error/warning/info
 * дублируется в центр уведомлений (колокольчик в шапке) и хранится на сервере — чтобы не
 * теряться между вкладками и устройствами. loading/promise/dismiss — как есть, без записи.
 */
type Msg = Parameters<typeof sonner.success>[0];
type Opts = Parameters<typeof sonner.success>[1];

const text = (m: Msg): string | null => (typeof m === 'string' ? m : null);

function record(severity: NotificationSeverity, message: Msg, opts?: Opts): void {
  const title = text(message);
  if (!title) return;
  const description = typeof opts?.description === 'string' ? opts.description : undefined;
  void notificationsApi
    .create({ severity, title, ...(description ? { body: description } : {}) })
    .then(() => queryClient.invalidateQueries({ queryKey: notificationsKeys.list }))
    .catch(() => {
      /* нет сети или не авторизованы — всплывашка всё равно показана */
    });
}

export const toast = Object.assign(
  (message: Msg, opts?: Opts) => {
    record('info', message, opts);
    return sonner(message, opts);
  },
  {
    success: (message: Msg, opts?: Opts) => {
      record('ok', message, opts);
      return sonner.success(message, opts);
    },
    error: (message: Msg, opts?: Opts) => {
      record('crit', message, opts);
      return sonner.error(message, opts);
    },
    warning: (message: Msg, opts?: Opts) => {
      record('warn', message, opts);
      return sonner.warning(message, opts);
    },
    info: (message: Msg, opts?: Opts) => {
      record('info', message, opts);
      return sonner.info(message, opts);
    },
    message: sonner.message,
    loading: sonner.loading,
    promise: sonner.promise,
    custom: sonner.custom,
    dismiss: sonner.dismiss,
  },
);
