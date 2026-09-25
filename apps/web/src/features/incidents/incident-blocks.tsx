import {
  ATTEMPT_STATUS_LABELS,
  actionMeta,
  type Incident,
  type IncidentAttempt,
  type IncidentEvent,
} from '@nodeservice/shared';
import { CheckIcon, CopyIcon, Loader2Icon, TerminalIcon, WrenchIcon } from 'lucide-react';

import { formatWhen } from '@/features/audit/audit-format';
import { useServers } from '@/features/servers/servers-api';
import { useTerminalStore } from '@/features/terminal/terminal-store';
import { toast } from '@/lib/notify';
import { useNow } from '@/lib/use-now';
import { cn } from '@/lib/utils';
import { LevelChip } from './level-chip';

const RESULT_DOT: Record<IncidentEvent['result'], string> = {
  detect: 'bg-brand',
  notify: 'bg-text-3',
  applied: 'bg-brand',
  helped: 'bg-ok',
  failed: 'bg-crit',
  escalate: 'bg-warn',
  resolved: 'bg-ok',
};
const STEP_ICON: Record<IncidentAttempt['steps'][number]['status'], { cls: string; mark: string }> = {
  pending: { cls: 'bg-surface-3 text-text-3', mark: '·' },
  running: { cls: 'bg-brand-soft text-brand', mark: '…' },
  ok: { cls: 'bg-ok-soft text-ok', mark: '✓' },
  failed: { cls: 'bg-crit-soft text-crit', mark: '✕' },
  skipped: { cls: 'bg-surface-3 text-text-3', mark: '–' },
};

/** Хронология инцидента: время, точка по итогу события с линией, текст, уровень и кто. */
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
            {e.level && <LevelChip level={e.level} />}
            {e.by === 'auto' ? 'Авто' : 'Вручную'}
          </span>
        </li>
      ))}
    </ol>
  );
}

/** Попытка: шаги с отметками, секунды, вывод команды в раскрытии. */
export function AttemptBlock({ attempt, index }: { attempt: IncidentAttempt; index: number }) {
  const action = actionMeta(attempt.action);
  const running = attempt.status === 'running';
  // Пока попытка идёт, секунды у текущего шага тикают сами, а не только при перечитывании.
  const now = useNow(running);
  const secs = (s: IncidentAttempt['steps'][number]) =>
    s.startedAt && s.finishedAt
      ? `${((new Date(s.finishedAt).getTime() - new Date(s.startedAt).getTime()) / 1000).toFixed(1)} с`
      : running && s.status === 'running' && s.startedAt
        ? `${Math.max(0, Math.round((now - new Date(s.startedAt).getTime()) / 1000))} с`
        : '';
  // Старые записи, где шаг остался «выполняется» после конца попытки, показываем по итогу попытки.
  const stepStatus = (st: IncidentAttempt['steps'][number]['status']) =>
    !running && st === 'running'
      ? attempt.status === 'helped' || attempt.status === 'done'
        ? 'ok'
        : 'failed'
      : st;
  return (
    <div
      data-testid="attempt-block"
      className={cn(
        'rounded-[12px] border p-3.5',
        running
          ? 'border-brand/40 bg-[linear-gradient(180deg,var(--ns-brand-soft),transparent_70%)]'
          : attempt.status === 'helped'
            ? 'border-ok/30 bg-surface'
            : 'border-border bg-surface',
      )}
    >
      <div className="flex flex-wrap items-center gap-2 text-[12.5px] font-semibold">
        {running ? (
          <Loader2Icon className="size-4 animate-spin text-brand" aria-hidden="true" />
        ) : (
          <WrenchIcon className="size-4 text-text-3" aria-hidden="true" />
        )}
        Попытка {index} · {action.title}
        <LevelChip level={attempt.level} />
        <span className="ml-auto text-[11.5px] font-normal text-text-3">
          {attempt.by === 'auto' ? 'Автоматически' : 'По вашей команде'} ·{' '}
          {ATTEMPT_STATUS_LABELS[attempt.status]}
        </span>
      </div>
      <ol className="mt-2.5 flex flex-col gap-1.5">
        {attempt.steps.map((s) => {
          const status = stepStatus(s.status);
          const ic = STEP_ICON[status];
          return (
            <li
              key={s.key}
              className={cn(
                'grid grid-cols-[22px_minmax(0,1fr)_auto] items-center gap-2.5 rounded-[9px] border border-border bg-surface px-2.5 py-1.5 text-[12.5px]',
                status === 'pending' && 'opacity-55',
              )}
            >
              <span
                aria-hidden="true"
                className={cn('grid size-4 place-items-center rounded-[5px] text-[10px] font-bold', ic.cls)}
              >
                {ic.mark}
              </span>
              <span className={cn('min-w-0', status === 'failed' && 'text-crit')}>
                {s.label}
                {s.note && <span className="text-text-3">: {s.note}</span>}
              </span>
              <span className="text-[11.5px] text-text-3 tabular-nums">{secs(s)}</span>
            </li>
          );
        })}
      </ol>
      {attempt.log && (
        <details className="mt-2" open={running}>
          <summary className="cursor-pointer text-[12px] text-text-3">
            Вывод команды ({attempt.log.split('\n').filter(Boolean).length} стр.)
          </summary>
          <pre className="mt-1.5 max-h-[220px] overflow-auto rounded-[9px] border border-border bg-bg-2 px-3 py-2 font-mono text-[11.5px] leading-relaxed whitespace-pre-wrap text-text-2">
            {attempt.log}
          </pre>
        </details>
      )}
    </div>
  );
}

/** Предложенный следующий шаг: T2/T1 — подтверждение без пароля; T3 — команда для терминала. */
export function ProposalBlock({
  incident,
  onRun,
  busy,
}: {
  incident: Incident;
  onRun: () => void;
  busy: boolean;
}) {
  const proposal = incident.proposal;
  const servers = useServers();
  const openTerminal = useTerminalStore((st) => st.open);
  if (!proposal) return null;
  const action = actionMeta(proposal.action);
  const server = servers.data?.items.find((s) => s.id === incident.serverId);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(action.summary);
      toast.success('Команда скопирована.');
    } catch {
      toast.error('Не удалось скопировать — выделите команду вручную.');
    }
  };
  return (
    <div
      data-testid="proposal-block"
      className={cn(
        'rounded-[12px] border p-3.5',
        proposal.level === 'T3'
          ? 'border-crit/30 bg-surface'
          : 'border-warn/40 bg-[linear-gradient(180deg,var(--ns-warn-soft),transparent_70%)]',
      )}
    >
      <div className="flex flex-wrap items-center gap-2 text-[13px] font-semibold">
        <WrenchIcon className="size-4 text-warn" aria-hidden="true" />
        {proposal.level === 'T3' ? 'Следующий шаг только вручную' : 'Следующий шаг требует подтверждения'}
        <LevelChip level={proposal.level} />
      </div>
      <p className="mt-1.5 text-[13px] leading-normal">
        <b>{action.title}</b>
        {action.consequence && <span className="text-text-2"> — {action.consequence}</span>}. Причина:{' '}
        {proposal.reason}.
      </p>
      {proposal.level !== 'T3' && (
        <ul className="mt-2 flex flex-col gap-1 text-[12px] text-text-2">
          <li>Перед запуском проверим: {action.preconditions.join(', ')}.</li>
          <li>После: {action.postcheck}.</li>
          <li>Откат: {action.rollbackNote ?? 'нет'}.</li>
        </ul>
      )}
      <div className="mt-2.5 rounded-[9px] bg-bg-2 px-3 py-2 font-mono text-[12px] break-all text-text-2">
        {action.summary}
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {proposal.level === 'T3' ? (
          <>
            <button
              type="button"
              onClick={() => void copy()}
              className="inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-[9px] border border-border bg-surface-2 px-3 text-[12.5px] font-medium text-text-2 hover:bg-surface-3 hover:text-foreground"
            >
              <CopyIcon className="size-3.5" aria-hidden="true" />
              Копировать команду
            </button>
            {server && (
              <button
                type="button"
                onClick={() =>
                  openTerminal({
                    id: server.id,
                    name: server.name,
                    host: server.host,
                    port: server.port,
                    sshUser: server.sshUser,
                  })
                }
                className="inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-[9px] bg-cta px-3 text-[12.5px] font-semibold text-cta-foreground hover:bg-(--ns-cta-hover)"
              >
                <TerminalIcon className="size-3.5" aria-hidden="true" />
                Открыть терминал
              </button>
            )}
          </>
        ) : (
          <button
            type="button"
            disabled={busy}
            onClick={onRun}
            className="inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-[9px] bg-cta px-3.5 text-[12.5px] font-semibold text-cta-foreground hover:bg-(--ns-cta-hover) disabled:opacity-50"
          >
            {busy ? (
              <Loader2Icon className="size-3.5 animate-spin" aria-hidden="true" />
            ) : (
              <CheckIcon className="size-3.5" aria-hidden="true" />
            )}
            Подтвердить: {action.title.toLowerCase()}
          </button>
        )}
      </div>
    </div>
  );
}
