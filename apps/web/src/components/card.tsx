import { Link, type LinkProps } from '@tanstack/react-router';
import { ArrowRightIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

/**
 * Карточка раздела общей сетки: шапка 56 px с заголовком, счётчиком, пояснением и действиями справа,
 * поля по бокам 16 px, радиус 16. Одна и та же на «Обзоре» и в остальных разделах.
 */
export function Card({
  title,
  count,
  sub,
  end,
  children,
  className,
}: {
  title: ReactNode;
  count?: ReactNode;
  sub?: ReactNode;
  end?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      className={cn(
        'flex min-w-0 flex-col overflow-hidden rounded-2xl border border-border bg-surface',
        className,
      )}
    >
      <header className="flex min-h-14 flex-wrap items-center gap-x-2.5 gap-y-1 border-b border-border px-4 py-3">
        {/* Счётчик — часть заголовка: «Требует внимания 2» читается целиком. */}
        <h2 className="flex items-center gap-2.5 font-heading text-[14.5px] font-semibold tracking-[-0.005em]">
          {title}
          {count != null && ' '}
          {count}
        </h2>
        {sub && <span className="text-[12px] text-text-3">{sub}</span>}
        {end && <div className="ml-auto flex items-center gap-2">{end}</div>}
      </header>
      {children}
    </section>
  );
}

/** Счётчик в шапке карточки. */
export function CountBadge({ n, tone = 'muted' }: { n: ReactNode; tone?: 'muted' | 'warn' | 'crit' | 'ok' }) {
  return (
    <span
      className={cn(
        'inline-grid h-[22px] min-w-6 place-items-center rounded-full px-[7px] text-[12px] font-bold tabular-nums',
        tone === 'crit'
          ? 'bg-crit-soft text-crit'
          : tone === 'warn'
            ? 'bg-warn-soft text-warn'
            : tone === 'ok'
              ? 'bg-ok-soft text-ok'
              : 'bg-surface-2 text-text-2',
      )}
    >
      {n}
    </span>
  );
}

/** Ссылка «Все ноды →» в шапке карточки. */
export function CardLink({ children, ...link }: LinkProps & { children: ReactNode }) {
  return (
    <Link
      {...link}
      className="inline-flex items-center gap-[5px] rounded-[6px] text-[12.5px] font-medium whitespace-nowrap text-brand transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-brand"
    >
      {children}
      <ArrowRightIcon className="size-[13px]" aria-hidden="true" />
    </Link>
  );
}

/**
 * Карточка графика: подпись заглавными и пояснение слева, крупное значение справа, график и сноска ниже.
 */
export function ChartCard({
  title,
  sub,
  value,
  valueSub,
  end,
  foot,
  children,
  className,
}: {
  title: ReactNode;
  sub?: ReactNode;
  value?: ReactNode;
  valueSub?: ReactNode;
  end?: ReactNode;
  foot?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      className={cn('min-w-0 rounded-2xl border border-border bg-surface px-4 pt-[18px] pb-3', className)}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-[11.5px] font-semibold tracking-[0.08em] text-text-2 uppercase">{title}</h2>
          {sub && <div className="mt-[3px] text-[12px] text-text-3">{sub}</div>}
        </div>
        {value != null && (
          <div className="text-right font-heading text-[22px] leading-[1.1] font-bold whitespace-nowrap tabular-nums">
            {value}
            {valueSub && (
              <small className="mt-[3px] block font-sans text-[11.5px] font-medium text-text-3">
                {valueSub}
              </small>
            )}
          </div>
        )}
        {end}
      </div>
      {children}
      {foot && <p className="mt-1.5 text-[11.5px] text-text-3">{foot}</p>}
    </section>
  );
}
