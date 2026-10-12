import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';
export function NavGroupLabel({ children, hidden }: { children: ReactNode; hidden?: boolean }) {
  return (
    <div
      className={cn(
        'flex items-center gap-2 px-3 pt-3 pb-1.5 text-[10.5px] font-semibold tracking-[0.13em] text-text-3 uppercase first:pt-1',
        hidden && 'sr-only',
      )}
    >
      <span aria-hidden="true" className="h-3 w-[3px] shrink-0 rounded-full bg-brand" />
      <span>{children}</span>
    </div>
  );
}
