import type { ComponentProps, ReactNode } from 'react';

import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';

/** Поле ввода в стиле демо (.auth-card .inp): 11/12px, surface-2, радиус 10, фокус — accent. */
export const authInputClass =
  'h-auto rounded-[10px] border-border bg-surface-2 px-3 py-[11px] text-[14.5px] text-foreground placeholder:text-text-3 dark:bg-surface-2 focus-visible:border-brand focus-visible:ring-3 focus-visible:ring-brand-soft aria-invalid:border-crit aria-invalid:ring-crit-soft dark:aria-invalid:border-crit dark:aria-invalid:ring-crit-soft disabled:opacity-60';

/** Чекбокс 18px с радиусом 6 (.chk .box из демо). */
export const authCheckboxClass =
  'size-[18px] rounded-[6px] border-border-2 bg-surface-2 data-checked:border-brand data-checked:bg-brand data-checked:text-(--ns-on-accent) dark:bg-surface-2 dark:data-checked:bg-brand';

export function AuthInput({ className, ...props }: ComponentProps<typeof Input>) {
  return <Input className={cn(authInputClass, className)} {...props} />;
}

interface FieldProps {
  id: string;
  label: ReactNode;
  hint?: ReactNode;
  error?: string | undefined;
  children: ReactNode;
  className?: string;
}

/** Подпись + контрол + подсказка/ошибка. Ошибка связана с контролом через aria-describedby у вызывающего. */
export function Field({ id, label, hint, error, children, className }: FieldProps) {
  return (
    <div className={cn('flex min-w-0 flex-col gap-1.5', className)}>
      <Label htmlFor={id} className="text-[12.5px] font-medium text-text-2">
        {label}
      </Label>
      {children}
      {error ? (
        <p id={`${id}-error`} className="text-[12px] leading-snug text-crit">
          {error}
        </p>
      ) : hint ? (
        <p id={`${id}-hint`} className="text-[12px] leading-normal text-text-3">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

/** Вертикальный стек полей формы (.fields, gap 14px). */
export function Fields({ className, ...props }: ComponentProps<'form'>) {
  return <form noValidate className={cn('flex flex-col gap-3.5', className)} {...props} />;
}
