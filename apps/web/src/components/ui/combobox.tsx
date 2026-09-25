import { CheckIcon, ChevronDownIcon, SearchIcon } from 'lucide-react';
import { Popover as PopoverPrimitive } from 'radix-ui';
import { type KeyboardEvent, type ReactNode, useEffect, useId, useMemo, useRef, useState } from 'react';

import { cn } from '@/lib/utils';

export interface ComboOption {
  value: string;
  /** Текст для поиска и для доступного имени пункта. */
  label: string;
  /** Дополнительные слова поиска: адрес сайта, синонимы. */
  keywords?: string;
  /** Как пункт выглядит в списке и в поле, когда выбран. По умолчанию — label. */
  node?: ReactNode;
}

const norm = (s: string): string => s.toLowerCase().replace(/ё/g, 'е').trim();

type Entry =
  | { kind: 'none'; key: string }
  | { kind: 'option'; key: string; option: ComboOption }
  | { kind: 'action'; key: string };

/**
 * Выпадающий список с поиском внутри. Радикальный Select не умеет держать поле ввода (набор букв
 * у него прыгает по пунктам), поэтому это Popover со своим listbox. Поиск показывается, когда
 * пунктов не меньше `searchFrom`; последний пункт-действие («Добавить…») всегда виден под списком.
 */
export function Combobox({
  id,
  value,
  onChange,
  options,
  ariaLabel,
  placeholder,
  emptyLabel,
  searchPlaceholder = 'Найти…',
  searchFrom = 8,
  action,
  disabled,
  className,
}: {
  id?: string;
  value: string | null;
  onChange: (value: string | null) => void;
  options: ComboOption[];
  ariaLabel: string;
  /** Что видно в поле, когда ничего не выбрано. */
  placeholder: ReactNode;
  /** Пункт «ничего не выбрано» в начале списка; без него значение сбросить нельзя. */
  emptyLabel?: string;
  searchPlaceholder?: string;
  searchFrom?: number;
  action?: { label: string; icon?: ReactNode; onSelect: () => void };
  disabled?: boolean;
  className?: string;
}) {
  const auto = useId();
  const base = id ?? auto;
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const searchable = options.length >= searchFrom;
  const q = norm(query);

  const filtered = useMemo(
    () => (q ? options.filter((o) => norm(`${o.label} ${o.keywords ?? ''}`).includes(q)) : options),
    [options, q],
  );

  const entries: Entry[] = useMemo(() => {
    const list: Entry[] = [];
    if (emptyLabel && !q) list.push({ kind: 'none', key: '__none' });
    for (const option of filtered) list.push({ kind: 'option', key: option.value, option });
    if (action) list.push({ kind: 'action', key: '__action' });
    return list;
  }, [emptyLabel, q, filtered, action]);

  const selected = options.find((o) => o.value === value) ?? null;

  // biome-ignore lint/correctness/useExhaustiveDependencies: сброс и подсветка нужны только в момент открытия, иначе каждый ввод сбивал бы выбор
  useEffect(() => {
    if (!open) return;
    setQuery('');
    const at = value ? entries.findIndex((e) => e.kind === 'option' && e.option.value === value) : 0;
    setActive(Math.max(0, at));
  }, [open]);

  useEffect(() => {
    setActive((a) => Math.min(a, Math.max(0, entries.length - 1)));
  }, [entries.length]);

  useEffect(() => {
    if (!open) return;
    const el = listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`);
    el?.scrollIntoView?.({ block: 'nearest' });
  }, [active, open]);

  const choose = (entry: Entry | undefined) => {
    if (!entry) return;
    if (entry.kind === 'action') {
      setOpen(false);
      action?.onSelect();
      return;
    }
    onChange(entry.kind === 'none' ? null : entry.option.value);
    setOpen(false);
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((a) => Math.min(entries.length - 1, a + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => Math.max(0, a - 1));
    } else if (e.key === 'Home') {
      e.preventDefault();
      setActive(0);
    } else if (e.key === 'End') {
      e.preventDefault();
      setActive(entries.length - 1);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      choose(entries[active]);
    }
  };

  const listId = `${base}-list`;
  const optId = (i: number) => `${base}-opt-${i}`;

  const row =
    'flex w-[calc(100%-8px)] cursor-pointer items-center gap-2 rounded-[8px] mx-1 px-2.5 py-2 text-left text-[13px] text-text-2';

  return (
    <PopoverPrimitive.Root open={open} onOpenChange={setOpen}>
      <PopoverPrimitive.Trigger asChild>
        <button
          type="button"
          id={id}
          role="combobox"
          aria-label={ariaLabel}
          aria-expanded={open}
          aria-haspopup="listbox"
          aria-controls={open ? listId : undefined}
          disabled={disabled}
          className={cn(
            'flex h-10 w-full cursor-pointer items-center justify-between gap-2 rounded-[10px] border border-border bg-surface-2 px-3 text-[13px] text-foreground outline-none transition-colors hover:bg-surface-3 focus-visible:border-brand/50 disabled:cursor-not-allowed disabled:opacity-50 data-[state=open]:border-brand/50',
            className,
          )}
        >
          <span className="flex min-w-0 items-center gap-2 truncate">
            {selected ? (selected.node ?? selected.label) : placeholder}
          </span>
          <ChevronDownIcon
            className={cn('size-4 flex-none opacity-70 transition-transform', open && 'rotate-180')}
            aria-hidden="true"
          />
        </button>
      </PopoverPrimitive.Trigger>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          sideOffset={6}
          collisionPadding={12}
          align="start"
          className="z-[110] w-[var(--radix-popover-trigger-width)] min-w-[14rem] overflow-hidden rounded-[12px] border border-border-2 bg-surface shadow-float outline-none data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95"
        >
          {searchable && (
            <div className="mx-2 mt-2 mb-1 flex h-[34px] items-center gap-2 rounded-[9px] border border-border bg-surface-2 px-2.5 focus-within:border-brand/50">
              <SearchIcon className="size-[15px] flex-none text-text-3" aria-hidden="true" />
              <input
                // biome-ignore lint/a11y/noAutofocus: поиск должен принимать ввод сразу после открытия списка
                autoFocus
                type="text"
                role="searchbox"
                aria-label={`Поиск: ${ariaLabel}`}
                aria-controls={listId}
                aria-activedescendant={entries.length > 0 ? optId(active) : undefined}
                autoComplete="off"
                spellCheck={false}
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setActive(0);
                }}
                onKeyDown={onKeyDown}
                placeholder={searchPlaceholder}
                className="min-w-0 flex-1 bg-transparent text-[13px] text-foreground outline-none placeholder:text-text-3"
              />
            </div>
          )}
          {/* biome-ignore lint/a11y/useSemanticElements: listbox с подсветкой и прокруткой, нативный select здесь не подходит */}
          <div
            ref={listRef}
            id={listId}
            role="listbox"
            aria-label={ariaLabel}
            tabIndex={searchable ? -1 : 0}
            aria-activedescendant={!searchable && entries.length > 0 ? optId(active) : undefined}
            onKeyDown={searchable ? undefined : onKeyDown}
            className="max-h-[250px] overflow-y-auto py-1 outline-none"
          >
            {entries.map((entry, i) => {
              if (entry.kind === 'action') return null;
              const isNone = entry.kind === 'none';
              const on = isNone ? value === null : value === entry.option.value;
              return (
                // biome-ignore lint/a11y/useKeyWithClickEvents: клавиатура обрабатывается на listbox и в поле поиска
                <div
                  key={entry.key}
                  id={optId(i)}
                  role="option"
                  tabIndex={-1}
                  aria-selected={on}
                  aria-label={isNone ? emptyLabel : entry.option.label}
                  data-index={i}
                  onMouseMove={() => setActive(i)}
                  onClick={() => choose(entry)}
                  className={cn(row, i === active && 'bg-surface-2 text-foreground', on && 'text-foreground')}
                >
                  <span className="flex min-w-0 flex-1 items-center gap-2">
                    {isNone ? (
                      <span className="text-text-3">{emptyLabel}</span>
                    ) : (
                      (entry.option.node ?? entry.option.label)
                    )}
                  </span>
                  {on && <CheckIcon className="size-4 flex-none text-brand" aria-hidden="true" />}
                </div>
              );
            })}
            {filtered.length === 0 && (
              <div className="px-3.5 py-4 text-[13px] text-text-2">Ничего не найдено.</div>
            )}
          </div>
          {(action || searchable) && (
            <div className="flex items-center gap-2 border-t border-border bg-surface-2 px-3 py-1.5 text-[12px] text-text-3">
              {searchable && (
                <span aria-live="polite">
                  {q ? `Найдено ${filtered.length} из ${options.length}` : `Всего: ${options.length}`}
                </span>
              )}
              <span className="flex-1" />
              {action && (
                // biome-ignore lint/a11y/useSemanticElements: пункт-действие входит в общую навигацию стрелками
                <div
                  id={optId(entries.length - 1)}
                  role="button"
                  tabIndex={-1}
                  aria-label={action.label}
                  data-index={entries.length - 1}
                  onMouseMove={() => setActive(entries.length - 1)}
                  onClick={() => choose(entries[entries.length - 1])}
                  className={cn(
                    'flex cursor-pointer items-center gap-1.5 rounded-[7px] px-2 py-1 text-[12.5px] font-semibold text-brand',
                    active === entries.length - 1 && 'bg-brand-soft',
                  )}
                >
                  {action.icon}
                  {action.label}
                </div>
              )}
            </div>
          )}
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}
