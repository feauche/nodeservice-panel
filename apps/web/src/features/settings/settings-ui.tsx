import { InfoIcon } from 'lucide-react';
import type { ButtonHTMLAttributes, KeyboardEvent, ReactNode } from 'react';

import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';

/**
 * Единый вид «Настроек» (витрина redesign-2026-10, раздел «Настройки», вариант A): шапка раздела, карточки
 * с заголовком и пояснением, строки «подпись и пояснение слева — управление справа», поля и кнопки 40 px.
 * Сохранение одно: полоса «Сохранить» внизу появляется только после правки. Мгновенные действия — кнопкой
 * `RowButton` справа в строке.
 */

/** Шапка раздела: название и одно предложение о том, что тут настраивается; справа — статус или действие. */
export function SectionHeader({
  title,
  description,
  aside,
}: {
  title: string;
  description: ReactNode;
  aside?: ReactNode;
}) {
  return (
    <header className="mb-1 flex items-start gap-3">
      <div className="min-w-0 flex-1">
        <h2 className="m-0 font-heading text-[18px] font-bold tracking-[-0.01em]">{title}</h2>
        <div className="mt-1 text-[12.5px] text-text-3">{description}</div>
      </div>
      {aside && <div className="flex flex-none items-center gap-2">{aside}</div>}
    </header>
  );
}

/** Карточка настроек: шапка с заголовком и пояснением, под ней строки; `footer` — полоса действий справа. */
export function SettingsCard({
  title,
  hint,
  children,
  footer,
  aside,
  className,
}: {
  title: string;
  hint?: ReactNode;
  children: ReactNode;
  /** Своё действие карточки (например, «Сменить пароль»): прижато вправо, слева — пояснение. */
  footer?: ReactNode;
  /** Состояние справа в шапке (пилюля «Сигнал идёт»); на телефоне — над заголовком. */
  aside?: ReactNode;
  className?: string;
}) {
  const head = (
    <>
      <h3 className="m-0 font-heading text-[14.5px] font-semibold tracking-[-0.005em]">{title}</h3>
      {/* Пояснение может быть разметкой (например, скелетон даты) — поэтому div, а не p. */}
      {hint && <div className="mt-0.5 text-[12px] leading-snug text-text-3">{hint}</div>}
    </>
  );
  return (
    <section className={cn('overflow-hidden rounded-2xl border border-border bg-surface', className)}>
      {aside ? (
        <div className="flex min-h-14 items-start gap-3 border-b border-border px-5 py-3 max-md:px-4 max-sm:flex-col-reverse max-sm:gap-2">
          <div className="min-w-0 flex-1">{head}</div>
          <div className="flex flex-none items-center pt-px">{aside}</div>
        </div>
      ) : (
        <div className="flex min-h-14 flex-col justify-center border-b border-border px-5 py-3 max-md:px-4">
          {head}
        </div>
      )}
      <div className="px-5 max-md:px-4">{children}</div>
      {footer && (
        <div className="flex flex-wrap items-center justify-end gap-2.5 border-t border-border bg-bg-2 px-5 py-3.5 max-md:px-4 [&>button]:h-10">
          {footer}
        </div>
      )}
    </section>
  );
}

/** Скелетон карточки настроек: шапка и строки «подпись и пояснение — поле» той же высоты, что готовые. */
export function SettingsCardSkeleton({ rows = 3 }: { rows?: number }) {
  return (
    <section aria-hidden="true" className="overflow-hidden rounded-2xl border border-border bg-surface">
      <div className="flex min-h-14 flex-col justify-center gap-1.5 border-b border-border px-5 py-3 max-md:px-4">
        <Skeleton className="h-3.5 w-40" />
        <Skeleton className="h-3 w-72 max-w-full" />
      </div>
      <div className="px-5 max-md:px-4">
        {Array.from({ length: rows }, (_, i) => i + 1).map((row) => (
          <div
            key={row}
            className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-5 border-t border-border py-3.5 first:border-t-0"
          >
            <div className="space-y-2">
              <Skeleton className="h-3.5 w-1/3" />
              <Skeleton className="h-3 w-2/3" />
            </div>
            <Skeleton className="h-10 w-[150px] rounded-[10px] max-sm:w-24" />
          </div>
        ))}
      </div>
    </section>
  );
}

/** Скелетон раздела: карточки с заданным числом строк — по форме готового раздела. */
export function SettingsSkeleton({ cards }: { cards: number[] }) {
  return (
    <div role="status" aria-label="Загрузка настроек" className="flex flex-col gap-3.5">
      {cards
        .map((rows, i) => ({ rows, key: `${i}:${rows}` }))
        .map((c) => (
          <SettingsCardSkeleton key={c.key} rows={c.rows} />
        ))}
    </div>
  );
}

/** Строка настройки: подпись и пояснение слева, управление справа. `stack` — поле во всю ширину. */
export function SettingsRow({
  label,
  hint,
  children,
  htmlFor,
  stack,
  action,
}: {
  label?: ReactNode;
  hint?: ReactNode;
  children: ReactNode;
  htmlFor?: string;
  stack?: boolean;
  /** Для `stack`: кнопка справа от подписи (например, «Убрать ключ»). */
  action?: ReactNode;
}) {
  if (stack)
    return (
      <div className="flex flex-col gap-1.5 border-t border-border py-3.5 first:border-t-0">
        {(label || action) && (
          <div className="flex min-h-[30px] items-center justify-between gap-3">
            {label && (
              <label htmlFor={htmlFor} className="text-[13.5px] font-semibold">
                {label}
              </label>
            )}
            {action}
          </div>
        )}
        {children}
        {hint && <div className="text-[12px] leading-relaxed text-text-3">{hint}</div>}
      </div>
    );
  const Label = htmlFor ? 'label' : 'div';
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-5 gap-y-2 border-t border-border py-3.5 first:border-t-0 max-sm:grid-cols-1">
      <div className="min-w-0">
        {label && (
          <Label {...(htmlFor ? { htmlFor } : {})} className="block text-[13.5px] font-semibold">
            {label}
          </Label>
        )}
        {hint && <div className="mt-0.5 text-[12.5px] leading-relaxed text-text-3">{hint}</div>}
      </div>
      <div className="flex flex-wrap items-center justify-end gap-2 max-sm:justify-start">{children}</div>
    </div>
  );
}

/** Не загрузилось: причина словами и «Повторить» — вместо вечного скелетона или пустой карточки. */
export function LoadError({ message, onRetry }: { message: ReactNode; onRetry: () => void }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 py-3.5">
      <p role="alert" className="m-0 min-w-0 flex-1 text-[12.5px] text-crit">
        {message}
      </p>
      <RowButton onClick={onRetry}>Повторить</RowButton>
    </div>
  );
}

/** Кнопка действия в строке («Завершить», «Забыть», «Перевыпустить»): справа, высотой с поле. */
export function RowButton({
  children,
  tone = 'default',
  className,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { tone?: 'default' | 'danger' }) {
  return (
    <button
      type="button"
      {...rest}
      className={cn(
        'inline-flex h-10 cursor-pointer items-center justify-center gap-1.5 rounded-[10px] border bg-surface-2 px-3.5 text-[13px] font-medium whitespace-nowrap transition-colors disabled:cursor-default disabled:opacity-50 [&_svg]:size-3.5',
        tone === 'danger'
          ? 'border-crit/35 text-crit hover:border-crit/60'
          : 'border-border text-text-2 hover:border-border-2 hover:text-foreground',
        className,
      )}
    >
      {children}
    </button>
  );
}

/** Число с единицей измерения; диапазон — мелко слева от поля. */
export function NumberField({
  id,
  value,
  onChange,
  unit,
  min,
  max,
  invalid,
  disabled,
  decimal,
  'aria-label': ariaLabel,
}: {
  id: string;
  value: string;
  onChange: (v: string) => void;
  unit: string;
  min: number;
  max: number;
  invalid?: boolean;
  disabled?: boolean;
  /** Дробное число: клавиатура с запятой, диапазон — с запятой. */
  decimal?: boolean;
  'aria-label'?: string;
}) {
  return (
    <span className={cn('flex items-center gap-2', disabled && 'opacity-50')}>
      <span className="min-w-[62px] text-right text-[11px] text-text-3 tabular-nums">
        {decimal ? `${String(min).replace('.', ',')}–${String(max).replace('.', ',')}` : `${min}–${max}`}
      </span>
      <span
        className={cn(
          'flex h-10 items-center overflow-hidden rounded-[10px] border bg-surface-2 focus-within:border-brand',
          invalid ? 'border-crit' : 'border-border',
        )}
      >
        <input
          id={id}
          inputMode={decimal ? 'decimal' : 'numeric'}
          aria-label={ariaLabel}
          aria-invalid={invalid || undefined}
          disabled={disabled}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="w-[62px] border-0 bg-transparent px-2 text-right font-mono text-[13px] font-medium outline-none"
        />
        <span className="pr-2.5 pl-0.5 text-[12px] text-text-3">{unit}</span>
      </span>
    </span>
  );
}

/**
 * Одна полоса «Сохранить» на раздел: появляется после первой правки и прилипает к низу экрана, кнопки
 * справа одного размера. Слева — что с изменениями и пояснение `note`; `error` — почему сохранить нельзя
 * (показывается и без правок, например после неудачного сохранения).
 */
export function SaveBar({
  dirty,
  pending,
  onSave,
  onReset,
  note = 'попадут в Журнал',
  error,
  saveLabel = 'Сохранить',
}: {
  dirty: boolean;
  pending: boolean;
  onSave: () => void;
  onReset?: () => void;
  note?: ReactNode;
  /** Нельзя сохранить: причина вместо заметки, кнопка неактивна. */
  error?: ReactNode;
  saveLabel?: string;
}) {
  if (!dirty && !error) return null;
  return (
    <div className="sticky bottom-3 z-10 flex flex-wrap items-center justify-end gap-2.5 rounded-[14px] border border-border-2 bg-bg-2 px-4 py-3 shadow-pop duration-150 animate-in fade-in-0 slide-in-from-bottom-2 motion-reduce:animate-none">
      <span className="flex min-w-0 flex-1 items-center gap-2 text-[12.5px] text-text-2" aria-live="polite">
        {error ? (
          <span className="text-crit">{error}</span>
        ) : (
          <>
            <InfoIcon className="size-4 flex-none text-warn" aria-hidden="true" />
            <span className="min-w-0">
              Есть несохранённые изменения
              {note && <span className="text-text-3"> · {note}</span>}
            </span>
          </>
        )}
      </span>
      <span className="flex flex-none flex-wrap items-center justify-end gap-2.5 max-sm:w-full max-sm:[&>button]:flex-1">
        {dirty && onReset && (
          <button
            type="button"
            disabled={pending}
            onClick={onReset}
            className="inline-flex h-10 min-w-[128px] cursor-pointer items-center justify-center rounded-[10px] border border-border bg-surface-2 px-3.5 text-[13px] font-medium text-text-2 transition-colors hover:text-foreground disabled:opacity-50"
          >
            Отменить
          </button>
        )}
        <button
          type="button"
          disabled={pending || !dirty || Boolean(error)}
          onClick={onSave}
          className="inline-flex h-10 min-w-[128px] cursor-pointer items-center justify-center rounded-[10px] border border-transparent bg-cta px-3.5 text-[13px] font-semibold text-cta-foreground transition-colors hover:bg-(--ns-cta-hover) disabled:cursor-default disabled:opacity-50"
        >
          {pending ? 'Сохраняю…' : saveLabel}
        </button>
      </span>
    </div>
  );
}

/** Вторичная кнопка панели «Сохранить» (например, «По умолчанию»): того же размера. */
export function BarButton({ className, ...rest }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      {...rest}
      className={cn(
        'inline-flex h-10 min-w-[128px] cursor-pointer items-center justify-center gap-1.5 rounded-[10px] border border-border bg-surface-2 px-3.5 text-[13px] font-medium text-text-2 transition-colors hover:text-foreground disabled:cursor-default disabled:opacity-50 [&_svg]:size-3.5',
        className,
      )}
    />
  );
}

/** Основная кнопка в подвале карточки («Сменить пароль»): того же размера, что «Сохранить». */
export function CardButton({ className, ...rest }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      {...rest}
      className={cn(
        'inline-flex h-10 min-w-[128px] cursor-pointer items-center justify-center gap-1.5 rounded-[10px] border border-transparent bg-cta px-3.5 text-[13px] font-semibold text-cta-foreground transition-colors hover:bg-(--ns-cta-hover) disabled:cursor-default disabled:opacity-50',
        className,
      )}
    />
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

type PillTone = 'ok' | 'warn' | 'crit' | 'muted' | 'teal' | 'info';

const PILL: Record<PillTone, string> = {
  ok: 'bg-ok-soft text-ok',
  warn: 'bg-warn-soft text-warn',
  crit: 'bg-crit-soft text-crit',
  muted: 'bg-surface-2 text-text-3',
  // Изменение в Remnawave (Host изменён сценарием) — цвет шагов сценария.
  teal: 'bg-teal/15 text-teal',
  // Идёт прямо сейчас (проверка в работе).
  info: 'bg-brand-soft text-brand',
};

export function Pill({
  tone = 'muted',
  title,
  children,
}: {
  tone?: PillTone;
  /** Подсказка при наведении — на что именно отвечает эта пилюля, если это не очевидно из текста. */
  title?: string;
  children: ReactNode;
}) {
  return (
    <span
      title={title}
      className={cn(
        'inline-flex items-center justify-center rounded-full px-[9px] py-[3px] text-[11.5px] font-semibold whitespace-nowrap tabular-nums',
        PILL[tone],
      )}
    >
      {children}
    </span>
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
  /** `disabled` — вариант виден, но недоступен; `title` — почему (подсказка при наведении). */
  items: ReadonlyArray<{ key: K; label: ReactNode; disabled?: boolean; title?: string }>;
  value: K;
  onChange: (key: K) => void;
}) {
  const enabled = items.filter((i) => !i.disabled);
  const move = (e: KeyboardEvent, step: number) => {
    e.preventDefault();
    const at = enabled.findIndex((i) => i.key === value);
    const next = enabled[(at + step + enabled.length) % enabled.length];
    if (next) onChange(next.key);
  };
  return (
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
          aria-disabled={it.disabled || undefined}
          title={it.title}
          tabIndex={it.key === value ? 0 : -1}
          onClick={() => !it.disabled && onChange(it.key)}
          className={cn(
            'inline-flex flex-1 cursor-pointer items-center justify-center gap-1.5 rounded-[8px] px-2.5 py-1.5 text-center text-[13px] whitespace-nowrap transition-colors focus-visible:outline-2 focus-visible:outline-brand',
            it.key === value
              ? 'bg-surface font-semibold text-foreground shadow-[0_0_0_1px_var(--ns-border-2)]'
              : it.disabled
                ? 'cursor-default text-text-3 opacity-55'
                : 'text-text-3 hover:text-foreground',
          )}
        >
          {it.label}
        </button>
      ))}
    </div>
  );
}
