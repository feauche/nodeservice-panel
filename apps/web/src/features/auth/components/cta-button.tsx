import { Loader2Icon } from 'lucide-react';
import type { ComponentProps } from 'react';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

interface CtaButtonProps extends ComponentProps<typeof Button> {
  /** Идёт запрос — показать спиннер и подпись, кнопка недоступна. */
  loading?: boolean;
  loadingText?: string;
}

/** Главная кнопка: светлая на тёмном (и наоборот) — bg-cta / text-cta-foreground. */
export function CtaButton({
  loading,
  loadingText = 'Проверяю…',
  className,
  children,
  disabled,
  ...props
}: CtaButtonProps) {
  return (
    <Button
      type="submit"
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={cn(
        'h-auto w-full rounded-[10px] bg-cta px-[13px] py-[11px] text-[13.5px] font-semibold text-cta-foreground shadow-(--ns-cta-shadow) transition-[background,box-shadow,transform] duration-200 hover:bg-(--ns-cta-hover) hover:shadow-(--ns-cta-glow) focus-visible:ring-brand-soft active:translate-y-px disabled:opacity-50 disabled:shadow-none',
        className,
      )}
      {...props}
    >
      {loading ? (
        <>
          <Loader2Icon className="animate-spin" aria-hidden="true" />
          {loadingText}
        </>
      ) : (
        children
      )}
    </Button>
  );
}

/** Второстепенная кнопка (.btn.ghost из демо). */
export function GhostButton({ className, ...props }: ComponentProps<typeof Button>) {
  return (
    <Button
      type="button"
      variant="outline"
      className={cn(
        'h-auto rounded-[10px] border-border bg-transparent px-[13px] py-2 text-[12.5px] font-semibold text-foreground hover:border-border-2 hover:bg-surface-2 dark:border-border dark:bg-transparent dark:hover:bg-surface-2',
        className,
      )}
      {...props}
    />
  );
}
