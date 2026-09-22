import type { TerminalSessionInfo } from '@nodeservice/shared';
import { useEffect, useMemo, useState } from 'react';

import { Skeleton } from '@/components/ui/skeleton';
import { formatWhen } from '@/features/audit/audit-format';
import { useTerminalSession, useTerminalSessions } from '@/features/terminal/terminal-api';
import { stripAnsi } from '@/lib/strip-ansi';
import { cn } from '@/lib/utils';

function formatDuration(s: TerminalSessionInfo): string {
  const end = s.endedAt ? new Date(s.endedAt).getTime() : Date.now();
  const sec = Math.max(0, Math.round((end - new Date(s.startedAt).getTime()) / 1000));
  if (sec < 60) return `${sec} с`;
  const m = Math.floor(sec / 60);
  if (m < 60) return `${m} мин`;
  return `${Math.floor(m / 60)} ч ${m % 60} мин`;
}
function formatKb(bytes: number): string {
  if (bytes < 1024) return `${bytes} Б`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} КБ`;
  return `${(bytes / 1024 / 1024).toFixed(1)} МБ`;
}

/**
 * История терминала: слева сессии сервера, справа запись вывода выбранной (то, что видел
 * оператор, без цветовых кодов). Открытая сессия дописывается на глазах.
 */
export function TerminalHistoryTab({ serverId }: { serverId: string }) {
  const sessions = useTerminalSessions(serverId);
  const items = sessions.data?.items ?? [];
  const [selected, setSelected] = useState<string | null>(null);
  const activeId = selected ?? items[0]?.id ?? null;
  const detail = useTerminalSession(serverId, activeId);

  // При смене сервера выбор сбрасывается на самую свежую сессию.
  // biome-ignore lint/correctness/useExhaustiveDependencies: только по serverId
  useEffect(() => setSelected(null), [serverId]);

  if (sessions.isPending) {
    return (
      <div className="flex flex-col gap-2">
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-10 rounded-[8px]" />
        ))}
      </div>
    );
  }
  if (items.length === 0) {
    return (
      <div className="grid place-items-center rounded-2xl border border-dashed border-border-2 px-6 py-14 text-center">
        <p className="text-[13.5px] font-semibold">Сессий терминала ещё не было</p>
        <p className="mt-1 max-w-[420px] text-[12.5px] text-text-3">
          Откройте SSH-терминал, и всё, что покажет сервер, сохранится здесь: без ввода и паролей, только
          вывод. Записи хранятся 30 дней.
        </p>
      </div>
    );
  }

  const current = items.find((s) => s.id === activeId) ?? null;
  return (
    <TerminalHistoryView
      items={items}
      activeId={activeId}
      onSelect={setSelected}
      current={current}
      detail={detail}
    />
  );
}

function TerminalHistoryView({
  items,
  activeId,
  onSelect,
  current,
  detail,
}: {
  items: TerminalSessionInfo[];
  activeId: string | null;
  onSelect: (id: string) => void;
  current: TerminalSessionInfo | null;
  detail: ReturnType<typeof useTerminalSession>;
}) {
  // Очистка от ANSI — только когда изменился сам текст, а не на каждый рендер.
  const text = useMemo(() => (detail.data ? stripAnsi(detail.data.transcript) : ''), [detail.data]);
  return (
    <div className="grid h-full min-h-[360px] grid-cols-[240px_minmax(0,1fr)] gap-4 max-md:grid-cols-1">
      <ul className="flex min-h-0 flex-col gap-1 overflow-y-auto" aria-label="Сессии терминала">
        {items.map((s) => {
          const live = s.endedAt === null;
          return (
            <li key={s.id}>
              <button
                type="button"
                aria-pressed={s.id === activeId}
                onClick={() => onSelect(s.id)}
                className={cn(
                  'flex w-full cursor-pointer flex-col gap-0.5 rounded-[10px] border border-transparent px-3 py-2 text-left transition-colors hover:bg-surface-2',
                  s.id === activeId && 'border-border bg-surface-2',
                )}
              >
                <span className="flex items-center gap-2 text-[12.5px] font-medium">
                  {live && (
                    <span
                      aria-hidden="true"
                      className="size-1.5 rounded-full bg-ok shadow-[0_0_0_3px_var(--ns-ok-soft)]"
                    />
                  )}
                  {formatWhen(s.startedAt)}
                </span>
                <span className="text-[11.5px] text-text-3 tabular-nums">
                  {live ? 'идёт сейчас' : formatDuration(s)} · {formatKb(s.bytesOut)}
                  {s.truncated ? ' · усечена' : ''}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      <section className="flex min-h-0 flex-col overflow-hidden rounded-2xl border border-border bg-bg-2">
        <div className="flex items-center gap-3 border-b border-border px-4 py-2.5 text-[12px] text-text-3">
          <span>
            {current ? `Сессия от ${formatWhen(current.startedAt)}` : 'Сессия'}
            {current?.actorDisplay ? ` · ${current.actorDisplay}` : ''}
          </span>
          <span className="flex-1" />
          <span className="tabular-nums">
            {current ? `${current.cols}×${current.rows}` : ''}
            {current?.endReason ? ` · ${current.endReason}` : ''}
          </span>
        </div>
        {detail.isPending ? (
          <div className="flex flex-col gap-2 p-4">
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-4 rounded-[6px]" />
            ))}
          </div>
        ) : (
          <pre
            data-testid="terminal-transcript"
            className="min-h-0 flex-1 overflow-auto px-4 py-3 font-mono text-[12px] leading-[1.5] whitespace-pre-wrap break-words text-text-2"
          >
            {detail.data ? text || '(пусто)' : '—'}
          </pre>
        )}
        {current?.truncated && (
          <div className="border-t border-border px-4 py-2 text-[11.5px] text-warn">
            Запись усечена: сохранены первые 2 МБ вывода, всего прошло {formatKb(current.bytesOut)}.
          </div>
        )}
      </section>
    </div>
  );
}
