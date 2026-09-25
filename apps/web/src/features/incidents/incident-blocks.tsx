import {
  ATTEMPT_STATUS_LABELS,
  actionMeta,
  type Incident,
  type IncidentAttempt,
  type IncidentEvent,
} from '@nodeservice/shared';
import { CheckIcon, ChevronDownIcon, CopyIcon, Loader2Icon, TerminalIcon, WrenchIcon } from 'lucide-react';
import { useState } from 'react';

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

const ATTEMPT_PILL: Record<
  IncidentAttempt['status'],
  { tone: 'ok' | 'warn' | 'crit' | 'muted' | 'run'; label: string }
> = {
  running: { tone: 'run', label: ATTEMPT_STATUS_LABELS.running },
  helped: { tone: 'ok', label: ATTEMPT_STATUS_LABELS.helped },
  not_helped: { tone: 'crit', label: ATTEMPT_STATUS_LABELS.not_helped },
  failed: { tone: 'crit', label: ATTEMPT_STATUS_LABELS.failed },
  precheck_failed: { tone: 'warn', label: ATTEMPT_STATUS_LABELS.precheck_failed },
  done: { tone: 'muted', label: ATTEMPT_STATUS_LABELS.done },
};

/** Длительность попытки: «19 с», «1 мин 5 с». */
const attemptDuration = (a: IncidentAttempt, now: number): string => {
  const end = a.finishedAt ? new Date(a.finishedAt).getTime() : now;
  const s = Math.max(0, Math.round((end - new Date(a.startedAt).getTime()) / 1000));
  return s < 60 ? `${s} с` : `${Math.floor(s / 60)} мин ${s % 60} с`;
};

/**
 * Попытки починки аккордеоном (витрина, A1): каждая — одна строка «номер · действие · уровень · кто ·
 * итог · время»; раскрыта только текущая (идущая или последняя), остальные — кликом. Так страница
 * не растягивается простынёй, а суть цепочки видна с одного взгляда.
 */
export function AttemptsAccordion({ attempts }: { attempts: IncidentAttempt[] }) {
  const followId = (attempts.find((a) => a.status === 'running') ?? attempts.at(-1))?.id;
  // Ручные раскрытия поверх «умолчания»: новая попытка раскрывается сама, прежняя сворачивается.
  const [manual, setManual] = useState<Record<string, boolean>>({});
  const anyRunning = attempts.some((a) => a.status === 'running');
  const now = useNow(anyRunning);
  return (
    <div className="overflow-hidden rounded-[12px] border border-border" data-testid="attempts">
      {attempts.map((a, i) => (
        <AttemptRow
          key={a.id}
          attempt={a}
          index={i + 1}
          now={now}
          open={manual[a.id] ?? a.id === followId}
          onToggle={() => setManual((m) => ({ ...m, [a.id]: !(m[a.id] ?? a.id === followId) }))}
        />
      ))}
    </div>
  );
}

function AttemptRow({
  attempt,
  index,
  now,
  open,
  onToggle,
}: {
  attempt: IncidentAttempt;
  index: number;
  now: number;
  open: boolean;
  onToggle: () => void;
}) {
  const action = actionMeta(attempt.action);
  const running = attempt.status === 'running';
  const pill = ATTEMPT_PILL[attempt.status];
  const panelId = `attempt-${attempt.id}`;
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
    <div data-testid="attempt-block" className="border-t border-border first:border-t-0">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={onToggle}
        className={cn(
          'grid w-full cursor-pointer grid-cols-[22px_minmax(0,1fr)_auto_16px] items-center gap-x-3 px-3.5 py-2.5 text-left text-[13px] transition-colors hover:bg-surface-2 sm:grid-cols-[22px_minmax(0,1fr)_auto_auto_auto_16px]',
          open && 'bg-surface-2',
        )}
      >
        <span className="text-[12.5px] text-text-3 tabular-nums">{index}</span>
        <span className="min-w-0">
          <span className="font-semibold">{action.title}</span>{' '}
          <span className="align-middle">
            <LevelChip level={attempt.level} />
          </span>
          <span className="mt-0.5 block text-[12px] text-text-3 sm:hidden">
            {attempt.by === 'auto' ? 'Автоматически' : 'По вашей команде'} · {attemptDuration(attempt, now)}
          </span>
        </span>
        <span className="hidden text-[12px] whitespace-nowrap text-text-3 sm:block">
          {attempt.by === 'auto' ? 'Автоматически' : 'По вашей команде'}
        </span>
        <span
          className={cn(
            'inline-flex items-center gap-1.5 rounded-full px-[9px] py-[3px] text-[11.5px] font-semibold whitespace-nowrap',
            pill.tone === 'ok' && 'bg-ok-soft text-ok',
            pill.tone === 'warn' && 'bg-warn-soft text-warn',
            pill.tone === 'crit' && 'bg-crit-soft text-crit',
            pill.tone === 'muted' && 'bg-surface-3 text-text-3',
            pill.tone === 'run' && 'bg-brand-soft text-brand',
          )}
        >
          {running && <Loader2Icon className="size-3 animate-spin" aria-hidden="true" />}
          {pill.label}
        </span>
        <span className="hidden w-[64px] text-right text-[12px] whitespace-nowrap text-text-3 tabular-nums sm:block">
          {attemptDuration(attempt, now)}
        </span>
        <ChevronDownIcon
          className={cn('size-4 text-text-3 transition-transform duration-200', open && 'rotate-180')}
          aria-hidden="true"
        />
      </button>
      <div
        id={panelId}
        inert={!open}
        className={cn(
          'grid bg-surface-2 transition-[grid-template-rows] duration-200 ease-out motion-reduce:transition-none',
          open ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]',
        )}
      >
        <div className="min-h-0 overflow-hidden">
          <div className="px-3.5 pt-1 pb-3.5 sm:pl-[46px]">
            <ol className="flex flex-col gap-1.5">
              {attempt.steps.map((st) => {
                const status = stepStatus(st.status);
                const ic = STEP_ICON[status];
                return (
                  <li
                    key={st.key}
                    className={cn(
                      'grid grid-cols-[22px_minmax(0,1fr)_auto] items-center gap-2.5 rounded-[9px] border border-border bg-surface px-2.5 py-1.5 text-[12.5px]',
                      status === 'pending' && 'opacity-55',
                    )}
                  >
                    <span
                      aria-hidden="true"
                      className={cn(
                        'grid size-4 place-items-center rounded-[5px] text-[10px] font-bold',
                        ic.cls,
                      )}
                    >
                      {ic.mark}
                    </span>
                    <span className={cn('min-w-0', status === 'failed' && 'text-crit')}>
                      {st.label}
                      {st.note && <span className="text-text-3">: {st.note}</span>}
                    </span>
                    <span className="text-[11.5px] text-text-3 tabular-nums">{secs(st)}</span>
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
        </div>
      </div>
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
