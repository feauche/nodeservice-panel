import { type AuditEntry, type AuditListResponse, auditActionLabel } from '@nodeservice/shared';
import { useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useEffect, useState } from 'react';

import { Skeleton } from '@/components/ui/skeleton';
import { auditListQuery, useAuditList, useAuditStream } from '@/features/audit/audit-api';
import { formatWhen } from '@/features/audit/audit-format';
import { ResultPill } from '@/features/audit/audit-row';
import { cn } from '@/lib/utils';

/**
 * Журнал сервера: последние события и та же live-лента (SSE), что у полного Журнала —
 * новые записи по этому серверу появляются сверху сразу, с подсветкой.
 */
export function JournalTab({ serverId }: { serverId: string }) {
  const qc = useQueryClient();
  const query = { targetId: serverId, page: 1, pageSize: 25 } as const;
  const audit = useAuditList(query);
  const [fresh, setFresh] = useState<ReadonlySet<number>>(new Set());

  const stream = useAuditStream(true, (entry: AuditEntry) => {
    if (entry.targetId !== serverId) return;
    qc.setQueryData<AuditListResponse>(auditListQuery(query).queryKey, (old) => {
      if (!old || old.items.some((i) => i.seq === entry.seq)) return old;
      const total = old.total + 1;
      return {
        ...old,
        items: [entry, ...old.items].slice(0, old.pageSize),
        total,
        totalPages: Math.max(1, Math.ceil(total / old.pageSize)),
      };
    });
    setFresh((prev) => new Set(prev).add(entry.seq));
  });

  // Подсветка «новое» гаснет сама; при смене сервера список новых сбрасывается.
  // biome-ignore lint/correctness/useExhaustiveDependencies: только по serverId
  useEffect(() => setFresh(new Set()), [serverId]);
  useEffect(() => {
    if (fresh.size === 0) return;
    const t = setTimeout(() => setFresh(new Set()), 2600);
    return () => clearTimeout(t);
  }, [fresh]);

  const items = audit.data?.items ?? [];
  const live = stream === 'live';
  return (
    <section className="rounded-2xl border border-border bg-surface">
      <div className="flex items-center gap-2 border-b border-border px-4 py-2.5 text-[12px] text-text-3">
        <span
          aria-hidden="true"
          className={cn(
            'size-1.5 rounded-full',
            live ? 'bg-ok shadow-[0_0_0_3px_var(--ns-ok-soft)]' : 'bg-text-3',
          )}
        />
        <span aria-live="polite">
          {live
            ? 'Обновляется в реальном времени'
            : stream === 'off'
              ? 'Лента отключена'
              : 'Переподключение…'}
        </span>
        <span className="flex-1" />
        <span className="tabular-nums">{audit.data ? `${audit.data.total} событий` : ''}</span>
      </div>
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
              className={cn(
                'flex items-center gap-3 border-t border-border px-4 py-2.5 text-[13px] first:border-t-0',
                fresh.has(e.seq) && 'animate-[ns-flash_2.4s_ease-out]',
              )}
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
          Открыть весь Журнал
        </Link>
      </div>
    </section>
  );
}
