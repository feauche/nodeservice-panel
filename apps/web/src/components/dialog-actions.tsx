import type { ComponentProps } from 'react';

import { cn } from '@/lib/utils';

/**
 * Ряд кнопок диалога — одно правило для всех окон панели (как в ConfirmDialog из демо):
 * полоса внизу, кнопки по центру, одинаковой ширины (до 170px), на телефоне — столбиком.
 * Рассчитан на DialogContent с p-6 и rounded-2xl.
 */
export function DialogActions({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      className={cn(
        '-mx-6 -mb-6 mt-5 flex justify-center gap-3 rounded-b-2xl border-t border-border bg-surface-2/40 px-[22px] py-[18px] max-sm:flex-col',
        className,
      )}
      {...props}
    />
  );
}

const BASE =
  'inline-flex h-11 min-w-0 flex-1 cursor-pointer items-center justify-center gap-2 rounded-[11px] border px-4 text-[13.5px] font-semibold leading-[1.2] transition-[background,border-color,filter] duration-150 focus-visible:outline-2 focus-visible:outline-brand focus-visible:outline-offset-2 disabled:cursor-not-allowed disabled:opacity-50 sm:max-w-[210px] [&_svg]:size-4';

export function DialogPrimaryButton({ className, type = 'button', ...props }: ComponentProps<'button'>) {
  return (
    <button
      type={type}
      className={cn(
        BASE,
        'border-transparent bg-cta text-cta-foreground hover:bg-(--ns-cta-hover)',
        className,
      )}
      {...props}
    />
  );
}

export function DialogSecondaryButton({ className, type = 'button', ...props }: ComponentProps<'button'>) {
  return (
    <button
      type={type}
      className={cn(
        BASE,
        'border-border bg-surface-2 text-text-2 hover:bg-surface-3 hover:text-foreground',
        className,
      )}
      {...props}
    />
  );
}
