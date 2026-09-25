import type { ReachabilityResult } from '@nodeservice/shared';

import { cn } from '@/lib/utils';

const VERDICT: Record<
  ReachabilityResult['ports'][number]['verdict'],
  { tone: string; label: (p: number, o: number, t: number) => string }
> = {
  reachable: { tone: 'bg-ok-soft text-ok', label: (p) => `${p}: открыт со всех` },
  closed_everywhere: { tone: 'bg-crit-soft text-crit', label: (p) => `${p}: закрыт со всех` },
  partial: { tone: 'bg-warn-soft text-warn', label: (p, o, t) => `${p}: открыт с ${o} из ${t}` },
  unknown: { tone: 'bg-surface-3 text-text-3', label: (p) => `${p}: не проверен` },
};

function Cell({ open, ms }: { open: boolean; ms: number | null }) {
  return (
    <span className={cn('inline-flex items-center gap-1.5 font-semibold', open ? 'text-ok' : 'text-crit')}>
      <span className="size-2 rounded-full bg-current" aria-hidden="true" />
      {open ? `открыт${ms !== null ? ` · ${ms} мс` : ''}` : 'закрыт'}
    </span>
  );
}

/**
 * Доступность адреса снаружи (B1): матрица «кто проверял × порт», вывод по каждому порту и оговорка.
 * Вывод считает сервер, а не модель, поэтому картинка и слова в ответе не могут разойтись.
 */
export function ReachabilityCard({ result }: { result: ReachabilityResult }) {
  const ports = result.ports.map((p) => p.port);
  const answered = result.probes.filter((p) => p.ok).length;
  const dnsBad = !result.dns.consistent;
  return (
    <figure
      data-testid="reachability-card"
      className="m-0 mt-2.5 overflow-hidden rounded-[12px] border border-border bg-surface-2"
    >
      <figcaption className="flex flex-wrap items-baseline gap-x-2 border-b border-border px-3 py-2 text-[13px] font-semibold">
        Доступность {result.target.name} снаружи
        <span className="text-[12px] font-normal text-text-3">
          с {answered} {answered === 1 ? 'независимого сервера' : 'независимых серверов'} парка
        </span>
      </figcaption>
      {/* Узкий экран: матрица не помещается, поэтому по строке на проверяющего */}
      <ul aria-hidden="true" className="m-0 list-none p-0 sm:hidden">
        {result.probes.map((pr) => (
          <li key={pr.from} className="border-t border-border px-3 py-2 text-[12.5px]">
            <div className="flex items-baseline gap-2">
              <span className="font-medium">{pr.from}</span>
              {pr.ok && (
                <span
                  className={cn('ml-auto tabular-nums', dnsBad ? 'font-semibold text-warn' : 'text-text-3')}
                >
                  {pr.dns ?? '—'}
                </span>
              )}
            </div>
            {pr.ok ? (
              <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1">
                {ports.map((p) => {
                  const r = pr.ports.find((x) => x.port === p);
                  return (
                    <span key={p} className="inline-flex items-center gap-1.5">
                      <span className="text-text-3">{p}</span>
                      {r ? <Cell open={r.open} ms={r.ms} /> : <span className="text-text-3">нет данных</span>}
                    </span>
                  );
                })}
              </div>
            ) : (
              <div className="mt-1 text-text-3">Не ответил: {pr.error ?? 'нет данных'}</div>
            )}
          </li>
        ))}
      </ul>
      <div className="max-sm:hidden overflow-x-auto">
        <table className="w-full border-collapse text-[12.5px]">
          <thead>
            <tr>
              <th scope="col" className="px-3 py-1.5 text-left text-[11.5px] font-semibold text-text-3">
                Откуда
              </th>
              {ports.map((p) => (
                <th
                  key={p}
                  scope="col"
                  className="px-3 py-1.5 text-center text-[11.5px] font-semibold text-text-3"
                >
                  Порт {p}
                </th>
              ))}
              <th scope="col" className="px-3 py-1.5 text-center text-[11.5px] font-semibold text-text-3">
                DNS
              </th>
            </tr>
          </thead>
          <tbody>
            {result.probes.map((pr) => (
              <tr key={pr.from} className="border-t border-border">
                <th scope="row" className="px-3 py-1.5 text-left font-medium whitespace-nowrap">
                  {pr.from}
                </th>
                {pr.ok ? (
                  ports.map((p) => {
                    const r = pr.ports.find((x) => x.port === p);
                    return (
                      <td key={p} className="px-3 py-1.5 text-center whitespace-nowrap">
                        {r ? (
                          <Cell open={r.open} ms={r.ms} />
                        ) : (
                          <span className="text-text-3">нет данных</span>
                        )}
                      </td>
                    );
                  })
                ) : (
                  <td colSpan={ports.length} className="px-3 py-1.5 text-center text-text-3">
                    Не ответил: {pr.error ?? 'нет данных'}
                  </td>
                )}
                <td
                  className={cn(
                    'px-3 py-1.5 text-center tabular-nums',
                    dnsBad ? 'font-semibold text-warn' : 'text-text-3',
                  )}
                >
                  {pr.ok ? (pr.dns ?? '—') : '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="flex flex-col gap-1.5 border-t border-border bg-surface px-3 py-2">
        {result.ports.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {result.ports.map((p) => (
              <span
                key={p.port}
                title={p.text}
                className={cn(
                  'inline-flex h-[22px] items-center rounded-full px-2.5 text-[11.5px] font-semibold',
                  VERDICT[p.verdict].tone,
                )}
              >
                {VERDICT[p.verdict].label(p.port, p.open, p.open + p.closed)}
              </span>
            ))}
          </div>
        )}
        {result.notes.map((n) => (
          <p key={n} className="m-0 text-[12px] leading-snug text-text-3">
            {n}
          </p>
        ))}
      </div>
    </figure>
  );
}
