import { auditActionLabel } from '@nodeservice/shared';
import { Link } from '@tanstack/react-router';

import { Skeleton } from '@/components/ui/skeleton';
import { useAuditList } from '@/features/audit/audit-api';
import { formatWhen } from '@/features/audit/audit-format';
import { ResultPill } from '@/features/audit/audit-row';

export function JournalTab({ serverId }: { serverId: string }) {
  const audit = useAuditList({ targetId: serverId, page: 1, pageSize: 25 });
  const items = audit.data?.items ?? [];
  return (
    <section className="rounded-2xl border border-border bg-surface">
      {audit.isPending && (
        <div className="flex flex-col gap-2 p-4">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-8 rounded-[8px]" />
          ))}
        </div>
      )}
      {!audit.isPending && items.length === 0 && (
        <p className="px-4 py-8 text-center text-[13px] text-text-3">Событий по этому серверу пока нет.</p>
      )}
      {items.length > 0 && (
        <ul className="flex flex-col">
          {items.map((e) => (
            <li
              key={e.id}
              className="flex items-center gap-3 border-t border-border px-4 py-2.5 text-[13px] first:border-t-0"
            >
              <span className="w-[110px] flex-none text-text-3 tabular-nums">{formatWhen(e.occurredAt)}</span>
              <span className="min-w-0 flex-1 truncate">{auditActionLabel(e.action)}</span>
              <ResultPill result={e.result} />
            </li>
          ))}
        </ul>
      )}
      <div className="border-t border-border px-4 py-2.5">
        <Link to="/audit" className="text-[12.5px] font-medium text-brand underline-offset-2 hover:underline">
          Открыть весь Журнал →
        </Link>
      </div>
    </section>
  );
}
