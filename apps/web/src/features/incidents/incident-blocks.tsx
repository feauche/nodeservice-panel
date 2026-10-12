import type { IncidentEvent } from '@nodeservice/shared';

import { formatWhen } from '@/features/audit/audit-format';
import { cn } from '@/lib/utils';

const RESULT_DOT: Record<IncidentEvent['result'], string> = {
  detect: 'bg-brand',
  notify: 'bg-text-3',
  applied: 'bg-brand',
  helped: 'bg-ok',
  failed: 'bg-crit',
  escalate: 'bg-warn',
  resolved: 'bg-ok',
};

/** Хронология события: время, точка по итогу события с линией, текст и кто. */
export function Timeline({ events }: { events: IncidentEvent[] }) {
  return (
    <ol className="flex flex-col" aria-label="Хронология">
      {events.map((e, i) => (
        <li
          key={`${e.at}-${e.result}-${e.action}`}
          className="grid grid-cols-[104px_16px_minmax(0,1fr)_auto] items-start gap-x-2.5 py-1.5 max-sm:grid-cols-[16px_minmax(0,1fr)]"
        >
          <span className="pt-0.5 text-[11.5px] whitespace-nowrap text-text-3 tabular-nums max-sm:hidden">
            {formatWhen(e.at)}
          </span>
          {/* Точка и линия к следующему событию: линия рисуется в ячейке точки, поэтому не «плывёт» */}
          <span className="relative flex justify-center pt-[7px]" aria-hidden="true">
            {i < events.length - 1 && <span className="absolute top-[15px] -bottom-[13px] w-px bg-border" />}
            <span
              className={cn('relative block size-2 rounded-full ring-4 ring-surface', RESULT_DOT[e.result])}
            />
          </span>
          <span className="min-w-0 text-[12.5px]">
            <span className="hidden text-text-3 max-sm:block">{formatWhen(e.at)}</span>
            {e.action}
          </span>
          <span className="flex flex-none items-center gap-1.5 text-[11.5px] text-text-3 max-sm:col-start-2">
            {e.by === 'auto' ? 'Авто' : 'Вручную'}
          </span>
        </li>
      ))}
    </ol>
  );
}
