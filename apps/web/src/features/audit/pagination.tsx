import { ChevronLeftIcon, ChevronRightIcon } from 'lucide-react';

import { cn } from '@/lib/utils';

interface Props {
  page: number;
  totalPages: number;
  onChange: (page: number) => void;
}

/** Номера страниц с многоточиями: ‹ 1 … 4 5 6 … 20 › — всегда видны первая, последняя и соседи. */
export function pageItems(page: number, totalPages: number): Array<number | '…'> {
  if (totalPages <= 7) return Array.from({ length: totalPages }, (_, i) => i + 1);
  const pages = new Set<number>([1, totalPages, page - 1, page, page + 1]);
  if (page <= 3) for (const p of [2, 3, 4]) pages.add(p);
  if (page >= totalPages - 2) for (const p of [totalPages - 3, totalPages - 2, totalPages - 1]) pages.add(p);
  const sorted = [...pages].filter((p) => p >= 1 && p <= totalPages).sort((a, b) => a - b);
  const out: Array<number | '…'> = [];
  let prev = 0;
  for (const p of sorted) {
    if (p - prev > 1) out.push('…');
    out.push(p);
    prev = p;
  }
  return out;
}

export function Pagination({ page, totalPages, onChange }: Props) {
  if (totalPages <= 1) return null;
  const btn =
    'inline-flex h-8 min-w-8 cursor-pointer items-center justify-center rounded-[8px] px-2 text-[12.5px] font-medium tabular-nums text-text-2 transition-colors hover:bg-surface-2 hover:text-foreground disabled:cursor-default disabled:opacity-40 disabled:hover:bg-transparent';
  return (
    <nav aria-label="Страницы журнала" className="flex items-center gap-1">
      <button
        type="button"
        className={btn}
        disabled={page <= 1}
        onClick={() => onChange(page - 1)}
        aria-label="Предыдущая"
      >
        <ChevronLeftIcon className="size-4" />
      </button>
      {pageItems(page, totalPages).map((item, i) =>
        item === '…' ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: многоточия статичны
          <span key={`gap-${i}`} className="px-1 text-[12px] text-text-3">
            …
          </span>
        ) : (
          <button
            key={item}
            type="button"
            aria-current={item === page ? 'page' : undefined}
            className={cn(
              btn,
              item === page && 'bg-brand-soft text-brand hover:bg-brand-soft hover:text-brand',
            )}
            onClick={() => onChange(item)}
          >
            {item}
          </button>
        ),
      )}
      <button
        type="button"
        className={btn}
        disabled={page >= totalPages}
        onClick={() => onChange(page + 1)}
        aria-label="Следующая"
      >
        <ChevronRightIcon className="size-4" />
      </button>
    </nav>
  );
}
