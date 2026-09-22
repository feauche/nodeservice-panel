import type { ReactNode } from 'react';

import { cn } from '@/lib/utils';

/** Карточка настроек: скруглённая, на bg-surface, с подзаголовком-меткой. */
export function SettingsCard({
  title,
  hint,
  children,
  className,
}: {
  title: string;
  hint?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      className={cn('rounded-2xl border border-border bg-surface px-5 pt-4 pb-5 max-md:px-4', className)}
    >
      <h2 className="mb-1 text-[11px] font-semibold tracking-[0.1em] text-text-3 uppercase">{title}</h2>
      {hint && <p className="mb-1 text-[12.5px] text-text-2">{hint}</p>}
      {children}
    </section>
  );
}

/** Строка «название — значение» с верхней линией. */
export function SettingsRow({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1.5 border-t border-border py-3 first:border-t-0">
      <div className="min-w-0">
        <div className="text-[13.5px] font-medium">{label}</div>
        {hint && <div className="mt-0.5 text-[12px] text-text-3">{hint}</div>}
      </div>
      <div className="flex items-center gap-2 text-[13px] text-text-2">{children}</div>
    </div>
  );
}

/** Тумблер в стиле демо: role=switch, ползунок 18px. */
export function Toggle({
  id,
  checked,
  onChange,
  'aria-label': ariaLabel,
}: {
  id: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  'aria-label'?: string;
}) {
  return (
    <button
      type="button"
      id={id}
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      onClick={() => onChange(!checked)}
      className={cn(
        'relative h-6 w-11 flex-none cursor-pointer rounded-full border transition-colors',
        checked ? 'border-transparent bg-brand' : 'border-border bg-surface-3',
      )}
    >
      <span
        className={cn(
          'absolute top-[2px] left-[2px] size-[18px] rounded-full bg-white shadow transition-transform',
          checked && 'translate-x-5',
        )}
      />
    </button>
  );
}

type PillTone = 'ok' | 'warn' | 'crit' | 'muted';

const PILL: Record<PillTone, string> = {
  ok: 'bg-ok-soft text-ok',
  warn: 'bg-warn-soft text-warn',
  crit: 'bg-crit-soft text-crit',
  muted: 'bg-surface-2 text-text-3',
};

export function Pill({ tone = 'muted', children }: { tone?: PillTone; children: ReactNode }) {
  return (
    <span
      className={cn(
        'inline-flex rounded-full px-[9px] py-[3px] text-[11.5px] font-semibold whitespace-nowrap tabular-nums',
        PILL[tone],
      )}
    >
      {children}
    </span>
  );
}
