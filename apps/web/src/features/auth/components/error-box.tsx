import { TriangleAlertIcon } from 'lucide-react';
import type { ReactNode } from 'react';

import { formatSeconds } from '@/lib/api';
import { cn } from '@/lib/utils';

interface ErrorBoxProps {
  children: ReactNode;
  className?: string;
  /** Не объявлять блок живой областью (role=alert) — когда внутри тикающий таймер. */
  live?: boolean;
}

/** Красный мягкий блок с иконкой; role=alert (если live), трясётся при появлении. */
export function ErrorBox({ children, className, live = true }: ErrorBoxProps) {
  return (
    <div
      role={live ? 'alert' : undefined}
      className={cn(
        'flex animate-shake items-start gap-[9px] rounded-[10px] bg-crit-soft px-3 py-2.5 text-[12.5px] leading-[1.45] text-crit [&_b]:font-semibold',
        className,
      )}
    >
      <TriangleAlertIcon className="mt-px size-[15px] flex-none" aria-hidden="true" />
      <span>{children}</span>
    </div>
  );
}

/**
 * Сообщение о паузе после серии неудач: статичная фраза — в role=alert (озвучится один раз),
 * тикающий таймер — вне живой области, чтобы скринридер не читал каждую секунду.
 */
export function ThrottleBox({ left }: { left: number }) {
  return (
    <ErrorBox live={false}>
      <span role="alert">
        Слишком много неудачных попыток. Пауза растёт с каждой серией, постоянной блокировки нет.
      </span>{' '}
      Следующая попытка через{' '}
      <b aria-live="off" className="font-mono num">
        {formatSeconds(left)}
      </b>
      .
    </ErrorBox>
  );
}
