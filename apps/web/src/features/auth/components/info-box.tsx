import { InfoIcon } from 'lucide-react';
import type { ReactNode } from 'react';

import { cn } from '@/lib/utils';

/** Синий мягкий блок с подсказкой. <code> внутри рисуется как в демо. */
export function InfoBox({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        'flex animate-fade items-start gap-[9px] rounded-[10px] bg-brand-soft px-3 py-2.5 text-[12.5px] leading-normal text-text-2 [&_code]:my-[3px] [&_code]:inline-block [&_code]:rounded-[6px] [&_code]:border [&_code]:border-border [&_code]:bg-surface-2 [&_code]:px-[7px] [&_code]:py-px [&_code]:font-mono [&_code]:text-xs [&_code]:text-foreground',
        className,
      )}
    >
      <InfoIcon className="mt-0.5 size-[15px] flex-none text-brand" aria-hidden="true" />
      <span>{children}</span>
    </div>
  );
}
