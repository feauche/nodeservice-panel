import type { ButtonHTMLAttributes, ComponentType, KeyboardEvent, ReactNode } from 'react';

import { cn } from '@/lib/utils';

/**
 * Единый стиль «Настроек» (витрина `settings-unified-variants.html`, вариант A): шапка раздела, карточки
 * с заголовком обычным регистром, строки «подпись и пояснение слева — управление справа», одна липкая
 * панель «Сохранить» внизу справа на раздел. Мгновенные действия — кнопкой `RowButton` справа в строке.
 */

/** Шапка раздела: иконка, название, одно предложение о том, что тут настраивается; справа — статус. */
export function SectionHeader({
  icon: Icon,
  title,
  description,
  aside,
}: {
  icon: ComponentType<{ className?: string; 'aria-hidden'?: boolean | 'true' }>;
  title: string;
  description: ReactNode;
  aside?: ReactNode;
}) {
  return (
    <header className="mb-4 flex items-start gap-3">
      <span className="grid size-9 flex-none place-items-center rounded-[10px] border border-border bg-surface-2 text-brand">
        <Icon className="size-[18px]" aria-hidden="true" />
      </span>
      <div className="min-w-0 flex-1">
        <h2 className="m-0 font-heading text-[17px] font-semibold tracking-[-0.01em]">{title}</h2>
        <p className="m-0 mt-0.5 text-[12.5px] text-text-3">{description}</p>
      </div>
      {aside && <div className="flex-none pt-1">{aside}</div>}
    </header>
  );
}

/** Карточка настроек: заголовок обычным регистром, пояснение, строки; `footer` — полоса действий справа. */
export function SettingsCard({
  title,
  hint,
  children,
  footer,
  className,
}: {
  title: string;
  hint?: ReactNode;
  children: ReactNode;
  /** Своё действие карточки (например, «Сменить пароль»): прижато вправо, слева — пояснение. */
  footer?: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn('overflow-hidden rounded-[14px] border border-border bg-surface', className)}>
      <div className="px-[18px] pt-3.5 max-md:px-4">
        <h3 className="m-0 font-heading text-[14.5px] font-semibold tracking-[-0.01em]">{title}</h3>
        {hint && <p className="m-0 mt-0.5 text-[12.5px] text-text-3">{hint}</p>}
      </div>
      <div className="px-[18px] pt-1 pb-1.5 max-md:px-4">{children}</div>
      {footer && (
        <div className="flex flex-wrap items-center justify-end gap-2.5 border-t border-border bg-surface-2/60 px-[18px] py-3 max-md:px-4">
          {footer}
        </div>
      )}
    </section>
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
      <div className="flex flex-col gap-1.5 border-t border-border py-3 first:border-t-0">
        {(label || action) && (
          <div className="flex min-h-[30px] items-center justify-between gap-3">
            {label && (
              <label htmlFor={htmlFor} className="text-[12.5px] font-semibold">
                {label}
              </label>
            )}
            {action}
          </div>
        )}
        {children}
        {hint && <div className="text-[11.5px] text-text-3">{hint}</div>}
      </div>
    );
  const Label = htmlFor ? 'label' : 'div';
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-2 border-t border-border py-3 first:border-t-0 max-sm:grid-cols-1">
      <div className="min-w-0">
        {label && (
          <Label {...(htmlFor ? { htmlFor } : {})} className="block text-[13.5px] font-semibold">
            {label}
          </Label>
        )}
        {hint && <div className="mt-px text-[12px] text-text-3">{hint}</div>}
      </div>
      <div className="flex flex-wrap items-center justify-end gap-2 max-sm:justify-start">{children}</div>
    </div>
  );
}

/** Кнопка действия в строке («Завершить», «Забыть», «Перевыпустить»): небольшая, справа. */
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
        'inline-flex h-[30px] cursor-pointer items-center justify-center gap-1.5 rounded-[9px] border bg-surface-2 px-[11px] text-[12.5px] font-medium whitespace-nowrap transition-colors disabled:cursor-default disabled:opacity-50 [&_svg]:size-3.5',
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
  'aria-label'?: string;
}) {
  return (
    <span className={cn('flex items-center gap-2', disabled && 'opacity-50')}>
      <span className="min-w-[62px] text-right text-[11px] text-text-3 tabular-nums">
        {min}–{max}
      </span>
      <span
        className={cn(
          'flex h-[34px] items-center overflow-hidden rounded-[9px] border bg-surface-2 focus-within:border-brand',
          invalid ? 'border-crit' : 'border-border',
        )}
      >
        <input
          id={id}
          inputMode="numeric"
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
 * Одна панель «Сохранить» на раздел: липкая внизу, кнопки справа одного размера. Слева — что с
 * изменениями; `extra` — «По умолчанию» и подобные. «Отменить» показывается только при изменениях.
 */
export function SaveBar({
  dirty,
  pending,
  onSave,
  onReset,
  extra,
  note = 'Изменения попадают в Журнал.',
  error,
  saveLabel = 'Сохранить',
}: {
  dirty: boolean;
  pending: boolean;
  onSave: () => void;
  onReset?: () => void;
  extra?: ReactNode;
  note?: ReactNode;
  /** Нельзя сохранить: причина вместо заметки, кнопка неактивна. */
  error?: ReactNode;
  saveLabel?: string;
}) {
  return (
    // Без правок панель стоит в конце раздела; есть правки — прилипает к низу экрана, «Сохранить» под рукой.
    <div
      className={cn(
        'z-10 mt-1 flex flex-wrap items-center justify-end gap-2.5 rounded-[13px] border border-border bg-surface/95 py-2.5 pr-3 pl-4 backdrop-blur',
        dirty && 'sticky bottom-3 shadow-pop',
      )}
    >
      <span className="min-w-[200px] flex-1 text-[12.5px] text-text-3" aria-live="polite">
        {error ? (
          <span className="text-crit">{error}</span>
        ) : dirty ? (
          <>
            <span className="mr-1.5 inline-block size-1.5 rounded-full bg-warn align-middle" />
            Есть несохранённые изменения
          </>
        ) : (
          note
        )}
      </span>
      <span className="flex flex-none flex-wrap items-center justify-end gap-2.5">
        {extra}
        {dirty && onReset && (
          <button
            type="button"
            disabled={pending}
            onClick={onReset}
            className="inline-flex h-[34px] min-w-[128px] cursor-pointer items-center justify-center rounded-[9px] border border-border bg-surface-2 px-3.5 text-[13px] font-medium text-text-2 transition-colors hover:text-foreground disabled:opacity-50"
          >
            Отменить
          </button>
        )}
        <button
          type="button"
          disabled={pending || !dirty || Boolean(error)}
          onClick={onSave}
          className="inline-flex h-[34px] min-w-[128px] cursor-pointer items-center justify-center rounded-[9px] border border-transparent bg-cta px-3.5 text-[13px] font-semibold text-cta-foreground transition-colors hover:bg-(--ns-cta-hover) disabled:cursor-default disabled:opacity-50"
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
        'inline-flex h-[34px] min-w-[128px] cursor-pointer items-center justify-center gap-1.5 rounded-[9px] border border-border bg-surface-2 px-3.5 text-[13px] font-medium text-text-2 transition-colors hover:text-foreground disabled:cursor-default disabled:opacity-50 [&_svg]:size-3.5',
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
        'inline-flex h-[34px] min-w-[128px] cursor-pointer items-center justify-center gap-1.5 rounded-[9px] border border-transparent bg-cta px-3.5 text-[13px] font-semibold text-cta-foreground transition-colors hover:bg-(--ns-cta-hover) disabled:cursor-default disabled:opacity-50',
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

type PillTone = 'ok' | 'warn' | 'crit' | 'muted';

const PILL: Record<PillTone, string> = {
  ok: 'bg-ok-soft text-ok',
  warn: 'bg-warn-soft text-warn',
  crit: 'bg-crit-soft text-crit',
  muted: 'bg-surface-2 text-text-3',
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
