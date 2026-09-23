import type { Notification, NotificationSeverity } from '@nodeservice/shared';
import { Link } from '@tanstack/react-router';
import { BellIcon, CheckIcon, CircleAlertIcon, InfoIcon, TriangleAlertIcon, XIcon } from 'lucide-react';
import { Popover as PopoverPrimitive } from 'radix-ui';
import { useEffect, useRef, useState } from 'react';

import { ConfirmDialog } from '@/components/confirm-dialog';
import { formatWhen } from '@/features/audit/audit-format';
import { apiErrorMessage } from '@/lib/api';
import { toast } from '@/lib/notify';
import { cn } from '@/lib/utils';
import {
  useClearNotifications,
  useDeleteNotification,
  useNotifications,
  useReadAllNotifications,
} from './notifications-api';

const ICON: Record<NotificationSeverity, { cls: string; Icon: typeof InfoIcon }> = {
  info: { cls: 'bg-brand-soft text-brand', Icon: InfoIcon },
  ok: { cls: 'bg-ok-soft text-ok', Icon: CheckIcon },
  warn: { cls: 'bg-warn-soft text-warn', Icon: TriangleAlertIcon },
  crit: { cls: 'bg-crit-soft text-crit', Icon: CircleAlertIcon },
};

/** Через сколько после открытия списка непрочитанные считаются прочитанными. */
const READ_AFTER_MS = 1500;
const RETENTION_DAYS = 30;

/**
 * Колокольчик в шапке (витрина «Уведомления», вариант 1): попап со списком, непрочитанные с точкой
 * и подсветкой, у инцидентов ссылка, «×» у каждого, в подвале «Очистить все». Время — в часовом
 * поясе браузера, на сервере всё в UTC.
 */
export function NotificationBell() {
  const [open, setOpen] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const notifications = useNotifications();
  const readAll = useReadAllNotifications();
  const remove = useDeleteNotification();
  const clear = useClearNotifications();
  const unread = notifications.data?.unread ?? 0;
  const items = notifications.data?.items ?? [];
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Открыли список — через полторы секунды всё прочитано (точки гаснут после закрытия).
  useEffect(() => {
    if (!open || unread === 0) return;
    timer.current = setTimeout(() => void readAll.mutateAsync().catch(() => undefined), READ_AFTER_MS);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [open, unread, readAll.mutateAsync]);

  const onDelete = async (n: Notification) => {
    try {
      await remove.mutateAsync(n.id);
    } catch (err) {
      toast.error(apiErrorMessage(err));
    }
  };

  return (
    <>
      <PopoverPrimitive.Root open={open} onOpenChange={setOpen}>
        <PopoverPrimitive.Trigger
          aria-label={unread > 0 ? `Уведомления, непрочитанных: ${unread}` : 'Уведомления'}
          data-testid="notification-bell"
          className={cn(
            'relative grid size-9 flex-none cursor-pointer place-items-center rounded-[10px] border border-border bg-surface text-text-2 transition-colors hover:bg-surface-3 hover:text-foreground focus-visible:outline-2 focus-visible:outline-brand focus-visible:outline-offset-2 data-[state=open]:border-brand/40 data-[state=open]:bg-surface-2 data-[state=open]:text-foreground',
          )}
        >
          <BellIcon className="size-[17px]" aria-hidden="true" />
          {unread > 0 && (
            <span
              data-testid="notification-badge"
              className="absolute -top-1.5 -right-1.5 inline-flex min-w-[17px] justify-center rounded-full bg-crit px-1 text-[10.5px] leading-[17px] font-bold text-white tabular-nums shadow-[0_0_0_2px_var(--ns-surface)]"
            >
              {unread > 99 ? '99+' : unread}
            </span>
          )}
        </PopoverPrimitive.Trigger>
        <PopoverPrimitive.Portal>
          <PopoverPrimitive.Content
            align="end"
            sideOffset={8}
            collisionPadding={8}
            className="z-50 flex w-[380px] max-w-[calc(100vw-16px)] flex-col overflow-hidden rounded-[14px] border border-border-2 bg-surface shadow-float outline-none data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 motion-reduce:animate-none"
          >
            <div className="flex items-center gap-2 border-b border-border px-3.5 py-3">
              <h2 className="font-heading text-[14px] font-bold">Уведомления</h2>
              {unread > 0 && (
                <span className="rounded-full bg-crit-soft px-2 py-[1px] text-[11px] font-semibold text-crit">
                  {unread} новых
                </span>
              )}
            </div>
            <div
              className="max-h-[min(60vh,440px)] overflow-y-auto overscroll-contain"
              data-testid="notification-list"
            >
              {notifications.isPending && (
                <p className="px-4 py-8 text-center text-[12.5px] text-text-3">Загружаем…</p>
              )}
              {notifications.isError && (
                <p className="px-4 py-6 text-center text-[12.5px] text-crit">
                  {apiErrorMessage(notifications.error)}
                </p>
              )}
              {notifications.data && items.length === 0 && (
                <div className="px-4 py-10 text-center">
                  <BellIcon className="mx-auto size-6 text-text-3" aria-hidden="true" />
                  <p className="mt-2 text-[13px] font-semibold">Уведомлений нет</p>
                  <p className="mt-0.5 text-[12px] text-text-3">
                    Сюда попадают всплывашки и события инцидентов.
                  </p>
                </div>
              )}
              {items.map((n) => (
                <NotificationRow
                  key={n.id}
                  n={n}
                  onDelete={() => void onDelete(n)}
                  onNavigate={() => setOpen(false)}
                />
              ))}
            </div>
            <div className="flex items-center gap-2 border-t border-border bg-bg-2 px-3.5 py-2.5 text-[12px] text-text-3">
              <span className="min-w-0 flex-1 truncate">
                {items.length === 0
                  ? `Хранятся ${RETENTION_DAYS} дней`
                  : `${items.length} · хранятся ${RETENTION_DAYS} дней`}
              </span>
              <button
                type="button"
                disabled={items.length === 0 || clear.isPending}
                onClick={() => setConfirmClear(true)}
                className="cursor-pointer rounded-[8px] px-2 py-1 font-medium text-text-2 transition-colors hover:bg-surface-3 hover:text-foreground disabled:cursor-default disabled:opacity-50"
              >
                Очистить все
              </button>
            </div>
          </PopoverPrimitive.Content>
        </PopoverPrimitive.Portal>
      </PopoverPrimitive.Root>
      <ConfirmDialog
        open={confirmClear}
        onOpenChange={setConfirmClear}
        kind="warn"
        title="Очистить все уведомления?"
        description="Список опустеет. Инциденты и Журнал останутся на месте, это только уведомления."
        yesLabel="Очистить"
        loading={clear.isPending}
        onConfirm={async () => {
          try {
            await clear.mutateAsync();
            setConfirmClear(false);
          } catch (err) {
            setConfirmClear(false);
            toast.error(apiErrorMessage(err));
          }
        }}
      />
    </>
  );
}

function NotificationRow({
  n,
  onDelete,
  onNavigate,
}: {
  n: Notification;
  onDelete: () => void;
  onNavigate: () => void;
}) {
  const { cls, Icon } = ICON[n.severity];
  const unread = !n.readAt;
  return (
    <div
      data-testid="notification-row"
      data-unread={unread ? 'true' : undefined}
      className={cn(
        'relative grid grid-cols-[28px_minmax(0,1fr)_auto] items-start gap-2.5 border-t border-border px-3.5 py-2.5 first:border-t-0',
        unread && 'bg-brand-soft/40',
      )}
    >
      {unread && (
        <span aria-hidden="true" className="absolute top-[18px] left-1.5 size-1.5 rounded-full bg-brand" />
      )}
      <span className={cn('grid size-7 place-items-center rounded-[8px]', cls)} aria-hidden="true">
        <Icon className="size-3.5" />
      </span>
      <div className="min-w-0">
        <div className="text-[13px] leading-snug font-semibold">{n.title}</div>
        {n.body && <div className="mt-0.5 text-[12px] leading-normal text-text-2">{n.body}</div>}
        <div className="mt-1 flex flex-wrap items-center gap-x-2.5 text-[11.5px] text-text-3">
          <time dateTime={n.createdAt}>{formatWhen(n.createdAt)}</time>
          {n.link && (
            <Link to={n.link.to} onClick={onNavigate} className="font-semibold text-brand hover:underline">
              {n.link.label} →
            </Link>
          )}
        </div>
      </div>
      <button
        type="button"
        aria-label="Удалить уведомление"
        onClick={onDelete}
        className="grid size-6 cursor-pointer place-items-center rounded-[7px] text-text-3 transition-colors hover:bg-surface-3 hover:text-foreground"
      >
        <XIcon className="size-3.5" aria-hidden="true" />
      </button>
    </div>
  );
}
