import { CircleAlertIcon, CircleHelpIcon, Loader2Icon, TriangleAlertIcon } from 'lucide-react';
import { AlertDialog as AlertDialogPrimitive } from 'radix-ui';
import { type ReactNode, useCallback, useRef, useState } from 'react';

import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogDescription,
  AlertDialogOverlay,
  AlertDialogPortal,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { cn } from '@/lib/utils';

export type ConfirmKind = 'default' | 'warn' | 'crit';

export interface ConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Оттенок плитки с иконкой и кнопки «Да»: crit — красная кнопка, фокус на «Нет». */
  kind?: ConfirmKind;
  title: string;
  description: ReactNode;
  /** Приглушённая приписка под текстом. */
  note?: ReactNode;
  yesLabel?: string;
  noLabel?: string;
  onConfirm: () => void | Promise<void>;
  /** Идёт запрос: «Да» со спиннером, закрыть нельзя. */
  loading?: boolean;
}

const ICON: Record<ConfirmKind, typeof CircleHelpIcon> = {
  default: CircleHelpIcon,
  warn: TriangleAlertIcon,
  crit: CircleAlertIcon,
};

const TILE: Record<ConfirmKind, string> = {
  default: 'bg-brand-soft text-brand',
  warn: 'bg-warn-soft text-warn',
  crit: 'bg-crit-soft text-crit',
};

const BTN =
  'inline-flex min-w-0 flex-1 cursor-pointer items-center justify-center gap-1.5 rounded-[10px] border px-3.5 py-2.5 text-[13px] font-semibold leading-[1.2] transition-[background,border-color,filter] duration-150 focus-visible:outline-2 focus-visible:outline-brand focus-visible:outline-offset-2 disabled:cursor-not-allowed disabled:opacity-50 sm:max-w-[170px] [&_svg]:size-[15px]';

/**
 * Окно подтверждения из демо (.cf-*): плитка с иконкой 42px, заголовок, пояснение,
 * кнопки по центру одинаковой ширины — «Да, …» и «Нет». Esc и клик по фону = «Нет».
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  kind = 'default',
  title,
  description,
  note,
  yesLabel = 'Да',
  noLabel = 'Нет',
  onConfirm,
  loading,
}: ConfirmDialogProps) {
  const Icon = ICON[kind];
  const yesRef = useRef<HTMLButtonElement>(null);
  const noRef = useRef<HTMLButtonElement>(null);

  const close = () => {
    if (!loading) onOpenChange(false);
  };

  return (
    <AlertDialog open={open} onOpenChange={(o) => (o ? onOpenChange(true) : close())}>
      <AlertDialogPortal>
        {/* AlertDialog в Radix не закрывается кликом снаружи — поэтому клик по фону ловим на самом фоне. */}
        <AlertDialogOverlay onClick={close} className="z-90" />
        <AlertDialogPrimitive.Content
          data-slot="alert-dialog-content"
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            (kind === 'crit' ? noRef : yesRef).current?.focus({ preventScroll: true });
          }}
          onEscapeKeyDown={(e) => {
            if (loading) e.preventDefault();
          }}
          className="fixed top-1/2 left-1/2 z-90 w-[min(460px,calc(100%-32px))] -translate-x-1/2 -translate-y-1/2 rounded-2xl border border-border-2 bg-surface text-foreground shadow-float outline-none duration-150 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95"
        >
          <div className="flex items-start gap-3.5 p-[22px_22px_8px] phone:p-[18px_16px_6px]">
            <div
              aria-hidden="true"
              className={cn(
                'grid size-[42px] flex-none place-items-center rounded-xl [&_svg]:size-5',
                TILE[kind],
              )}
            >
              <Icon />
            </div>
            <div className="min-w-0 flex-1">
              <AlertDialogTitle className="mb-1.5 text-base font-semibold wrap-anywhere">
                {title}
              </AlertDialogTitle>
              <AlertDialogDescription className="text-[13px] leading-[1.55] wrap-anywhere text-text-2">
                {description}
              </AlertDialogDescription>
              {note && <div className="mt-2.5 text-[11.5px] text-text-3">{note}</div>}
            </div>
          </div>
          <div className="flex justify-center gap-3 p-[18px_22px_22px] max-sm:flex-col phone:p-[12px_16px_16px]">
            <button
              ref={yesRef}
              type="button"
              disabled={loading}
              aria-busy={loading || undefined}
              onClick={() => void onConfirm()}
              className={cn(
                BTN,
                kind === 'crit'
                  ? 'border-crit bg-crit text-white hover:brightness-[1.07]'
                  : 'border-brand bg-brand text-(--ns-on-accent) hover:brightness-[1.07]',
              )}
            >
              {loading && <Loader2Icon className="animate-spin" aria-hidden="true" />}
              {yesLabel}
            </button>
            <AlertDialogCancel
              ref={noRef}
              disabled={loading}
              variant="ghost"
              size="default"
              className={cn(
                BTN,
                'h-auto border-border bg-surface-2 text-foreground hover:border-border-2 hover:bg-surface-3 hover:text-foreground dark:border-border dark:bg-surface-2 dark:hover:bg-surface-3',
              )}
            >
              {noLabel}
            </AlertDialogCancel>
          </div>
        </AlertDialogPrimitive.Content>
      </AlertDialogPortal>
    </AlertDialog>
  );
}

/** Локальное состояние «окно открыто/закрыто» для ConfirmDialog. */
export function useConfirm() {
  const [open, setOpen] = useState(false);
  const show = useCallback(() => setOpen(true), []);
  const hide = useCallback(() => setOpen(false), []);
  return { open, show, hide, onOpenChange: setOpen };
}
