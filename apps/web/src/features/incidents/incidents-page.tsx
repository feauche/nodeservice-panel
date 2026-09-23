import {
  ATTEMPT_STATUS_LABELS,
  actionKeySchema,
  actionMeta,
  INCIDENT_KIND_META,
  type Incident,
  type IncidentAttempt,
  type IncidentEvent,
  type IncidentStatus,
} from '@nodeservice/shared';
import {
  CheckIcon,
  ChevronDownIcon,
  CopyIcon,
  Loader2Icon,
  ShieldCheckIcon,
  TerminalIcon,
  WrenchIcon,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { formatWhen } from '@/features/audit/audit-format';
import { useServers } from '@/features/servers/servers-api';
import { Pill } from '@/features/settings/settings-ui';
import { useTerminalStore } from '@/features/terminal/terminal-store';
import { apiErrorMessage } from '@/lib/api';
import { toast } from '@/lib/notify';
import { useNow } from '@/lib/use-now';
import { cn } from '@/lib/utils';
import { AutofixTab } from './autofix-tab';
import {
  type IncidentsFilter,
  useAcknowledgeIncident,
  useIncidents,
  useResolveIncident,
  useRunAction,
} from './incidents-api';
import { LevelChip } from './level-chip';

const FILTERS: ReadonlyArray<{ key: IncidentsFilter; label: string }> = [
  { key: 'all', label: 'Все' },
  { key: 'open', label: 'Открытые' },
  { key: 'resolved', label: 'Решённые' },
];
const SEV_DOT: Record<Incident['severity'], string> = {
  crit: 'bg-crit',
  warn: 'bg-warn',
  info: 'bg-brand',
};
const SEV_LABEL: Record<Incident['severity'], string> = { crit: 'критично', warn: 'внимание', info: 'инфо' };
const STATUS_PILL: Record<IncidentStatus, { tone: 'ok' | 'warn' | 'crit' | 'muted'; label: string }> = {
  open: { tone: 'crit', label: 'Открыт' },
  acknowledged: { tone: 'warn', label: 'В работе' },
  resolved: { tone: 'ok', label: 'Решён' },
};
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

type Tab = 'incidents' | 'autofix';

/** Инциденты (R3): хронология с уровнями T0–T3, попытки починки на месте, предложения «ждёт подтверждения», вкладка «Автопочинка». */
export function IncidentsPage({ openId }: { openId?: string | undefined } = {}) {
  const [tab, setTab] = useState<Tab>('incidents');
  const [filter, setFilter] = useState<IncidentsFilter>('all');
  const [expanded, setExpanded] = useState<string | null>(openId ?? null);
  // Пришли по ссылке из уведомления — раскрываем нужный инцидент.
  useEffect(() => {
    if (openId) setExpanded(openId);
  }, [openId]);
  const incidents = useIncidents(filter);
  const items = incidents.data?.items ?? [];
  const openCount = incidents.data?.counts.open ?? 0;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <fieldset className="m-0 flex h-9 w-fit items-center rounded-[10px] border border-border bg-surface p-[3px]">
          <legend className="sr-only">Раздел</legend>
          {(
            [
              ['incidents', 'Инциденты'],
              ['autofix', 'Автопочинка'],
            ] as Array<[Tab, string]>
          ).map(([key, label]) => (
            <button
              key={key}
              type="button"
              aria-pressed={tab === key}
              onClick={() => setTab(key)}
              className={cn(
                'h-full cursor-pointer rounded-[7px] px-3.5 text-[12.5px] font-medium text-text-3 transition-colors hover:text-foreground',
                tab === key && 'bg-surface-3 text-foreground',
              )}
            >
              {label}
            </button>
          ))}
        </fieldset>
        {tab === 'incidents' && (
          <fieldset className="m-0 flex h-9 w-fit items-center rounded-[10px] border border-border bg-surface p-[3px]">
            <legend className="sr-only">Фильтр инцидентов</legend>
            {FILTERS.map((f) => (
              <button
                key={f.key}
                type="button"
                aria-pressed={filter === f.key}
                onClick={() => setFilter(f.key)}
                className={cn(
                  'flex h-full cursor-pointer items-center gap-1.5 rounded-[7px] px-3.5 text-[12.5px] font-medium text-text-3 transition-colors hover:text-foreground',
                  filter === f.key && 'bg-surface-3 text-foreground',
                )}
              >
                {f.label}
                {f.key === 'open' && openCount > 0 && (
                  <span className="inline-flex min-w-[16px] justify-center rounded-full bg-crit px-1 text-[10.5px] font-bold text-white tabular-nums">
                    {openCount}
                  </span>
                )}
              </button>
            ))}
          </fieldset>
        )}
      </div>

      {tab === 'autofix' && <AutofixTab />}

      {tab === 'incidents' && incidents.isPending && (
        <div className="flex flex-col gap-3">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-[76px] rounded-2xl" />
          ))}
        </div>
      )}
      {tab === 'incidents' && incidents.isError && (
        <p className="rounded-[12px] border border-crit/30 bg-crit-soft px-4 py-3 text-[13px]">
          {apiErrorMessage(incidents.error)}{' '}
          <button type="button" className="cursor-pointer underline" onClick={() => void incidents.refetch()}>
            Повторить
          </button>
        </p>
      )}
      {tab === 'incidents' && incidents.data && items.length === 0 && (
        <div className="grid place-items-center rounded-2xl border border-dashed border-border px-6 py-16 text-center">
          <span className="grid size-11 place-items-center rounded-full bg-ok-soft text-ok">
            <ShieldCheckIcon className="size-6" aria-hidden="true" />
          </span>
          <h2 className="mt-3 font-heading text-[16px] font-bold">Пока спокойно</h2>
          <p className="mt-1 text-[13px] text-text-2">
            {filter === 'resolved' ? 'Решённых инцидентов нет.' : 'Инцидентов не найдено.'}
          </p>
        </div>
      )}
      {tab === 'incidents' && (
        <div className="flex flex-col gap-3">
          {items.map((inc) => (
            <IncidentCard
              key={inc.id}
              incident={inc}
              expanded={expanded === inc.id}
              onToggle={() => setExpanded((cur) => (cur === inc.id ? null : inc.id))}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/** Одна строка под заголовком: что делается и чем кончилось (витрина 4-1). */
function summaryLine(inc: Incident): React.ReactNode {
  const meta = INCIDENT_KIND_META[inc.kind];
  const when =
    inc.status === 'resolved' && inc.resolvedAt
      ? `${formatWhen(inc.openedAt)} → ${formatWhen(inc.resolvedAt)}`
      : `открыт ${formatWhen(inc.openedAt)}`;
  const parts: Array<[string, React.ReactNode]> = [
    ['component', meta.component],
    ['server', inc.serverName],
    ['when', when],
  ];
  const running = inc.attempts.find((a) => a.status === 'running');
  const last = [...inc.attempts].reverse().find((a) => a.level !== 'T0');
  if (running)
    parts.push([
      'run',
      <span key="run" className="inline-flex items-center gap-1 text-brand">
        <LevelChip level={running.level} /> {actionMeta(running.action).title} выполняется…
      </span>,
    ]);
  else if (inc.status === 'resolved' && last?.status === 'helped')
    parts.push([
      'ok',
      <span key="ok" className="inline-flex items-center gap-1 text-ok">
        <LevelChip level={last.level} /> {last.by === 'auto' ? 'авто' : 'вручную'}, «
        {actionMeta(last.action).title}» помогло
      </span>,
    ]);
  else if (inc.status === 'resolved')
    parts.push(['res', inc.resolvedBy === 'manual' ? 'закрыт вручную' : 'проблема исчезла сама']);
  else {
    if (last && last.status !== 'helped')
      parts.push([
        'last',
        <span key="last" className="inline-flex items-center gap-1">
          <LevelChip level={last.level} /> {actionMeta(last.action).title}{' '}
          {ATTEMPT_STATUS_LABELS[last.status]}
        </span>,
      ]);
    if (inc.proposal)
      parts.push([
        'prop',
        <span key="prop" className="inline-flex items-center gap-1 font-medium text-warn">
          <LevelChip level={inc.proposal.level} /> {actionMeta(inc.proposal.action).title}{' '}
          {inc.proposal.level === 'T3' ? 'только вручную' : 'ждёт подтверждения'}
        </span>,
      ]);
    if (!last && !inc.proposal && inc.kind === 'ssh_down') parts.push(['none', 'автопочинки нет']);
  }
  return parts.map(([key, node], i) => (
    <span key={key} className="inline-flex items-center gap-1">
      {i > 0 && <span aria-hidden="true">·</span>}
      {node}
    </span>
  ));
}

function IncidentCard({
  incident,
  expanded,
  onToggle,
}: {
  incident: Incident;
  expanded: boolean;
  onToggle: () => void;
}) {
  const status = STATUS_PILL[incident.status];
  return (
    <section
      className={cn(
        'overflow-hidden rounded-2xl border border-border bg-surface transition-colors',
        expanded && 'border-border-2',
      )}
    >
      <button
        type="button"
        data-testid="incident-card"
        aria-expanded={expanded}
        onClick={onToggle}
        className="flex w-full cursor-pointer items-center gap-3 px-4 py-3.5 text-left hover:bg-surface-2/50"
      >
        <span
          className={cn('size-2.5 flex-none rounded-full', SEV_DOT[incident.severity])}
          aria-hidden="true"
        />
        <span className="min-w-0 flex-1">
          <span className="block truncate font-heading text-[14.5px] font-bold tracking-[-0.01em]">
            {incident.title}
          </span>
          <span className="mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[12px] text-text-3">
            {summaryLine(incident)}
          </span>
        </span>
        <span className="hidden text-[11.5px] text-text-3 sm:inline">{SEV_LABEL[incident.severity]}</span>
        <Pill tone={status.tone}>{status.label}</Pill>
        <ChevronDownIcon
          className={cn('size-4 flex-none text-text-3 transition-transform', expanded && 'rotate-180')}
          aria-hidden="true"
        />
      </button>
      {expanded && <IncidentDetails incident={incident} />}
    </section>
  );
}

function IncidentDetails({ incident }: { incident: Incident }) {
  const ack = useAcknowledgeIncident();
  const resolve = useResolveIncident();
  const run = useRunAction();
  const [confirmResolve, setConfirmResolve] = useState(false);
  const running = incident.attempts.find((a) => a.status === 'running');
  const lastAttempt = running ?? incident.attempts.at(-1);
  const canAct = incident.status !== 'resolved' && incident.serverId !== null;

  const doRun = async (raw: string) => {
    const parsed = actionKeySchema.safeParse(raw);
    if (!parsed.success) {
      toast.error('Этого действия больше нет в реестре — закройте инцидент вручную.');
      return;
    }
    const action = parsed.data;
    try {
      await run.mutateAsync({ id: incident.id, action });
      toast.success(`«${actionMeta(action).title}» запущено — ход выполнения ниже.`);
    } catch (err) {
      toast.error(apiErrorMessage(err));
    }
  };

  return (
    <div className="border-t border-border bg-surface-2/30 px-4 py-4">
      <p className="text-[13px] text-text-2">{incident.detail}</p>

      <h3 className="mt-4 mb-2 text-[11px] font-semibold tracking-[0.09em] text-text-3 uppercase">
        Что происходило
      </h3>
      <ol className="flex flex-col gap-0" aria-label="Хронология">
        {incident.timeline.map((e, i) => (
          <li key={`${e.at}-${e.result}-${e.action}`} className="relative flex items-start gap-3 py-1.5">
            {i < incident.timeline.length - 1 && (
              <span
                aria-hidden="true"
                className="absolute top-[18px] left-[75px] h-[calc(100%-6px)] border-l border-border"
              />
            )}
            <span className="w-[64px] flex-none pt-0.5 text-[11.5px] text-text-3 tabular-nums">
              {formatWhen(e.at)}
            </span>
            <span className="mt-1.5 flex-none">
              <span
                className={cn('block size-2 rounded-full ring-4 ring-surface', RESULT_DOT[e.result])}
                aria-hidden="true"
              />
            </span>
            <span className="min-w-0 flex-1 text-[12.5px]">{e.action}</span>
            <span className="flex flex-none items-center gap-1.5 text-[11.5px] text-text-3">
              {e.level && <LevelChip level={e.level} />}
              {e.by === 'auto' ? 'авто' : 'вручную'}
            </span>
          </li>
        ))}
      </ol>

      {lastAttempt && (
        <AttemptBlock attempt={lastAttempt} index={incident.attempts.indexOf(lastAttempt) + 1} />
      )}

      {canAct && incident.proposal && !running && (
        <ProposalBlock
          incident={incident}
          onRun={() => void doRun(incident.proposal?.action ?? 'free_disk')}
          busy={run.isPending}
          onResolve={() => setConfirmResolve(true)}
        />
      )}

      {incident.status !== 'resolved' && (
        <div className="mt-4 flex flex-wrap items-center gap-2.5 border-t border-border pt-3.5">
          {canAct && !running && actionMeta('node_logs').kinds.includes(incident.kind) && (
            <button
              type="button"
              disabled={run.isPending}
              onClick={() => void doRun('node_logs')}
              title="Прочитать последние 100 строк docker logs remnanode — только чтение"
              className="inline-flex h-9 cursor-pointer items-center gap-1.5 rounded-[10px] border border-border bg-surface-2 px-3.5 text-[12.5px] font-medium text-text-2 transition-colors hover:bg-surface-3 hover:text-foreground disabled:opacity-50"
            >
              <TerminalIcon className="size-3.5" aria-hidden="true" />
              Логи ноды
              <LevelChip level="T0" />
            </button>
          )}
          {incident.status === 'open' && (
            <button
              type="button"
              disabled={ack.isPending}
              onClick={() => void ack.mutateAsync(incident.id)}
              className="inline-flex h-9 cursor-pointer items-center gap-1.5 rounded-[10px] border border-border bg-surface-2 px-3.5 text-[12.5px] font-medium text-text-2 transition-colors hover:bg-surface-3 hover:text-foreground disabled:opacity-50"
            >
              Взять в работу
            </button>
          )}
          <button
            type="button"
            disabled={resolve.isPending}
            onClick={() => setConfirmResolve(true)}
            className="inline-flex h-9 cursor-pointer items-center gap-1.5 rounded-[10px] border border-border bg-surface-2 px-3.5 text-[12.5px] font-medium text-text-2 transition-colors hover:bg-surface-3 hover:text-foreground disabled:opacity-50"
          >
            <CheckIcon className="size-3.5" aria-hidden="true" />
            Закрыть вручную
          </button>
        </div>
      )}
      {incident.status === 'resolved' && lastAttempt?.status === 'helped' && (
        <p className="mt-4 border-t border-border pt-3 text-[12px] text-text-3">
          Чинилось {lastAttempt.by === 'auto' ? 'автоматически' : 'по вашей команде'}: «
          {actionMeta(lastAttempt.action).title}» <LevelChip level={lastAttempt.level} /> · помогло{' '}
          {incident.attempts.length === 1 ? 'с первой попытки' : `с попытки ${incident.attempts.length}`}
        </p>
      )}

      <ConfirmDialog
        open={confirmResolve}
        onOpenChange={setConfirmResolve}
        title="Закрыть инцидент?"
        description="Инцидент будет отмечен как решённый вручную. Если проблема вернётся — панель заведёт новый."
        yesLabel="Закрыть"
        loading={resolve.isPending}
        onConfirm={async () => {
          try {
            await resolve.mutateAsync(incident.id);
            setConfirmResolve(false);
            toast.success('Инцидент закрыт.');
          } catch (err) {
            setConfirmResolve(false);
            toast.error(apiErrorMessage(err));
          }
        }}
      />
    </div>
  );
}

/** Попытка на месте (витрина 3-3): шаги с отметками, секунды, вывод команды в раскрытии. */
function AttemptBlock({ attempt, index }: { attempt: IncidentAttempt; index: number }) {
  const action = actionMeta(attempt.action);
  const running = attempt.status === 'running';
  // Пока попытка идёт, секунды у текущего шага тикают сами, а не только при перечитывании.
  const now = useNow(running);
  const secs = (s: IncidentAttempt['steps'][number]) =>
    s.startedAt && s.finishedAt
      ? `${((new Date(s.finishedAt).getTime() - new Date(s.startedAt).getTime()) / 1000).toFixed(1)} с`
      : s.status === 'running' && s.startedAt
        ? `${Math.max(0, Math.round((now - new Date(s.startedAt).getTime()) / 1000))} с`
        : '';
  return (
    <div
      data-testid="attempt-block"
      className={cn(
        'mt-3 rounded-[12px] border p-3.5',
        running
          ? 'border-brand/40 bg-[linear-gradient(180deg,var(--ns-brand-soft),transparent_70%)]'
          : attempt.status === 'helped'
            ? 'border-ok/30 bg-surface'
            : attempt.status === 'done'
              ? 'border-brand/30 bg-surface'
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
          {attempt.by === 'auto' ? 'авто' : 'вручную'} · {ATTEMPT_STATUS_LABELS[attempt.status]}
        </span>
      </div>
      <ol className="mt-2.5 flex flex-col gap-1.5">
        {attempt.steps.map((s) => {
          const ic = STEP_ICON[s.status];
          return (
            <li
              key={s.key}
              className={cn(
                'grid grid-cols-[22px_minmax(0,1fr)_auto] items-center gap-2.5 rounded-[9px] border border-border bg-surface px-2.5 py-1.5 text-[12.5px]',
                s.status === 'pending' && 'opacity-55',
              )}
            >
              <span
                aria-hidden="true"
                className={cn('grid size-4 place-items-center rounded-[5px] text-[10px] font-bold', ic.cls)}
              >
                {ic.mark}
              </span>
              <span className={cn('min-w-0', s.status === 'failed' && 'text-crit')}>
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
function ProposalBlock({
  incident,
  onRun,
  busy,
  onResolve,
}: {
  incident: Incident;
  onRun: () => void;
  busy: boolean;
  onResolve: () => void;
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
        'mt-3 rounded-[12px] border p-3.5',
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
        <button
          type="button"
          onClick={onResolve}
          className="inline-flex h-8 cursor-pointer items-center rounded-[9px] px-2.5 text-[12.5px] font-medium text-text-3 hover:text-foreground"
        >
          Закрыть инцидент вручную
        </button>
      </div>
    </div>
  );
}
