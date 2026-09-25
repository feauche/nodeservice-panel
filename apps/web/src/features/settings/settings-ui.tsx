import type { KeyboardEvent, ReactNode } from 'react';

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
  disabled,
  'aria-label': ariaLabel,
}: {
  id: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
  'aria-label'?: string;
}) {
  return (
    <button
      type="button"
      id={id}
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        'relative h-6 w-11 flex-none cursor-pointer rounded-full border transition-colors disabled:cursor-not-allowed disabled:opacity-50',
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

/**
 * Навигация по разделам внутри одной страницы настроек: слева столбцом, на узком экране лентой.
 * Точка у пункта — в разделе есть несохранённые изменения.
 */
export function SettingsRail<K extends string>({
  label,
  items,
  value,
  onChange,
}: {
  label: string;
  items: ReadonlyArray<{ key: K; label: string; dirty?: boolean }>;
  value: K;
  onChange: (key: K) => void;
}) {
  return (
    <nav
      aria-label={label}
      className="flex gap-1 overflow-x-auto max-lg:-mx-4 max-lg:px-4 max-lg:py-1 lg:sticky lg:top-4 lg:w-[210px] lg:flex-none lg:flex-col lg:self-start"
    >
      {items.map((it) => (
        <button
          key={it.key}
          type="button"
          aria-current={it.key === value ? 'true' : undefined}
          onClick={() => onChange(it.key)}
          className={cn(
            'flex flex-none items-center justify-between gap-2 rounded-[9px] px-3 py-2 text-left text-[13px] whitespace-nowrap transition-colors focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-brand',
            it.key === value
              ? 'bg-brand-soft font-semibold text-brand'
              : 'text-text-2 hover:bg-surface-2 hover:text-foreground',
          )}
        >
          {it.label}
          {it.dirty && (
            <span
              role="img"
              aria-label="Есть несохранённые изменения"
              className="size-1.5 flex-none rounded-full bg-warn"
            />
          )}
        </button>
      ))}
    </nav>
  );
}

/** Переключатель из нескольких вариантов в один ряд (radiogroup): стрелки меняют выбор. */
export function Segmented<K extends string>({
  label,
  items,
  value,
  onChange,
}: {
  label: string;
  items: ReadonlyArray<{ key: K; label: string }>;
  value: K;
  onChange: (key: K) => void;
}) {
  const move = (e: KeyboardEvent, step: number) => {
    e.preventDefault();
    const at = items.findIndex((i) => i.key === value);
    const next = items[(at + step + items.length) % items.length];
    if (next) onChange(next.key);
  };
  return (
    // biome-ignore lint/a11y/useSemanticElements: группа кнопок-переключателей со своей раскладкой
    <div
      role="radiogroup"
      aria-label={label}
      className="flex gap-[3px] rounded-[11px] border border-border bg-surface-2 p-[3px]"
      onKeyDown={(e) => {
        if (e.key === 'ArrowRight' || e.key === 'ArrowDown') move(e, 1);
        else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') move(e, -1);
      }}
    >
      {items.map((it) => (
        // biome-ignore lint/a11y/useSemanticElements: см. группу выше
        <button
          key={it.key}
          type="button"
          role="radio"
          aria-checked={it.key === value}
          tabIndex={it.key === value ? 0 : -1}
          onClick={() => onChange(it.key)}
          className={cn(
            'flex-1 cursor-pointer rounded-[8px] px-2.5 py-1.5 text-center text-[13px] transition-colors focus-visible:outline-2 focus-visible:outline-brand',
            it.key === value
              ? 'bg-surface font-semibold text-foreground shadow-[0_0_0_1px_var(--ns-border-2)]'
              : 'text-text-3 hover:text-foreground',
          )}
        >
          {it.label}
        </button>
      ))}
    </div>
  );
}
