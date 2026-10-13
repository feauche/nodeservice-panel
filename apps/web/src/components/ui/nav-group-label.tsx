import { ChevronDownIcon, ChevronRightIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

/** Сворачивание группы: развёрнута ли, что делать по нажатию, сколько пунктов и счётчик скрытых. */
export type NavGroupToggle = {
  open: boolean;
  onToggle: () => void;
  /** Сколько пунктов в группе — «УПРАВЛЕНИЕ · 7», когда свёрнута. */
  count: number;
  /** Сумма счётчиков скрытых пунктов (например, открытых событий): тревога не прячется. */
  badge?: number;
  /** id блока с пунктами — для aria-controls. */
  controls: string;
};

const ROW =
  'flex items-center gap-2 px-3 pt-3 pb-1.5 text-[10.5px] font-semibold tracking-[0.13em] text-text-3 uppercase first:pt-1';

/**
 * Заголовок группы меню. С `toggle` — кнопка (витрина menu-groups-2026-10, вариант A): стрелка справа (вниз —
 * развёрнута, вправо — свёрнута), у свёрнутой — число пунктов и счётчик скрытых. Высота строки та же.
 */
export function NavGroupLabel({
  children,
  hidden,
  toggle,
}: {
  children: ReactNode;
  hidden?: boolean;
  toggle?: NavGroupToggle | undefined;
}) {
  if (!toggle || hidden)
    return (
      <div className={cn(ROW, hidden && 'sr-only')}>
        <span aria-hidden="true" className="h-3 w-[3px] shrink-0 rounded-full bg-brand" />
        <span>{children}</span>
      </div>
    );
  const Chevron = toggle.open ? ChevronDownIcon : ChevronRightIcon;
  return (
    <button
      type="button"
      aria-expanded={toggle.open}
      aria-controls={toggle.controls}
      onClick={toggle.onToggle}
      className={cn(
        ROW,
        'w-full cursor-pointer rounded-[8px] text-left transition-colors hover:text-text-2 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-brand',
      )}
    >
      <span aria-hidden="true" className="h-3 w-[3px] shrink-0 rounded-full bg-brand" />
      <span className="min-w-0 flex-1 truncate">
        {children}
        {!toggle.open && <span className="tracking-normal"> · {toggle.count}</span>}
      </span>
      {!toggle.open && toggle.badge ? (
        <span className="inline-flex min-w-[17px] justify-center rounded-full bg-crit px-1 text-[10px] leading-[15px] font-bold tracking-normal text-white tabular-nums">
          {toggle.badge}
        </span>
      ) : null}
      <Chevron className="size-3.5 flex-none" aria-hidden="true" />
    </button>
  );
}
