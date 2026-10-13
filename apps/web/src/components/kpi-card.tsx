import type { ReactNode } from 'react';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';

export type KpiTone = 'ok' | 'warn' | 'crit' | 'info' | 'muted';

const DOT: Record<KpiTone, string> = {
  ok: 'bg-ok',
  warn: 'bg-warn',
  crit: 'bg-crit',
  info: 'bg-brand',
  muted: 'bg-text-3',
};

/** Мини-график в карточке показателя: своя SVG-линия без осей; пропуски линия перешагивает. */
export function Sparkline({
  values,
  className,
  stroke = 'var(--ns-text-3)',
}: {
  values: Array<number | null>;
  className?: string;
  stroke?: string;
}) {
  const w = 120;
  const h = 36;
  const pad = 2;
  const nums = values.filter((v): v is number => v != null);
  if (nums.length < 2) return null;
  const min = Math.min(...nums);
  const span = Math.max(...nums) - min || 1;
  const step = (w - pad * 2) / (values.length - 1);
  let d = '';
  values.forEach((v, i) => {
    if (v == null) return;
    const x = pad + i * step;
    const y = h - pad - ((v - min) / span) * (h - pad * 2);
    d += `${d ? ' L' : 'M'} ${x.toFixed(1)} ${y.toFixed(1)}`;
  });
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className={className} aria-hidden="true" data-testid="sparkline">
      <path d={d} fill="none" stroke={stroke} strokeWidth="1.6" strokeLinejoin="round" />
    </svg>
  );
}

/**
 * Карточка показателя — одна на все страницы: подпись заглавными, крупная цифра, состояние точкой и мини-график.
 * Размеры — общей сетки панели (поля 16, радиус 16).
 */
export function KpiCard({
  label,
  value,
  unit,
  status,
  tone = 'ok',
  spark,
  extra,
  className,
}: {
  label: string;
  value: ReactNode;
  /** Мелкая подпись после цифры: «/ 20», «Гбит/с», «% · 43,8 из 250,9 ГБ». */
  unit?: ReactNode;
  status?: ReactNode;
  tone?: KpiTone;
  spark?: Array<number | null>;
  /** Своё содержимое справа внизу вместо мини-графика: например, полоска срабатываний. */
  extra?: ReactNode;
  className?: string;
}) {
  return (
    <section
      className={cn(
        'flex min-w-0 flex-col gap-3 rounded-2xl border border-border bg-surface px-4 pt-[18px] pb-4',
        className,
      )}
    >
      <h2 className="truncate text-[11px] font-semibold tracking-[0.1em] text-text-3 uppercase">{label}</h2>
      <div className="flex min-w-0 items-baseline gap-1.5 font-heading text-[26px] leading-none font-semibold tracking-[-0.02em] whitespace-nowrap tabular-nums">
        {value}
        {unit != null && (
          <small className="truncate font-sans text-[13px] font-medium tracking-normal text-text-3">
            {unit}
          </small>
        )}
      </div>
      <div className="mt-auto flex min-h-[34px] items-end justify-between gap-2.5">
        {status != null && (
          <span className="flex min-w-0 items-center gap-[7px] text-[12.5px] text-text-2">
            <span className={cn('size-[7px] flex-none rounded-full', DOT[tone])} aria-hidden="true" />
            <span className="truncate">{status}</span>
          </span>
        )}
        {spark && <Sparkline values={spark} className="ml-auto h-9 w-28 flex-none opacity-80" />}
        {extra != null && <div className="ml-auto flex-none">{extra}</div>}
      </div>
    </section>
  );
}

/** Силуэт плитки показателя того же размера: подпись, число, строка состояния и место под спарклайн. */
export function KpiCardSkeleton({ className }: { className?: string }) {
  return (
    <section
      aria-hidden="true"
      className={cn(
        'flex min-w-0 flex-col gap-3 rounded-2xl border border-border bg-surface px-4 pt-[18px] pb-4',
        className,
      )}
    >
      <Skeleton className="h-2.5 w-[42%]" />
      <Skeleton className="h-[26px] w-[38%] rounded-[7px]" />
      <div className="mt-auto flex min-h-[34px] items-end justify-between gap-2.5">
        <Skeleton className="h-3 w-[36%]" />
        <Skeleton className="h-9 w-28 rounded-[8px]" />
      </div>
    </section>
  );
}

/** Подпись показателя заглавными — для плиток и шапок графиков. */
export function Caps({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn('text-[11px] font-semibold tracking-[0.1em] text-text-3 uppercase', className)}>
      {children}
    </div>
  );
}
