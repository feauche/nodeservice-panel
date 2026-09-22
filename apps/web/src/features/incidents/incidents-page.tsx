import {
  AUTOFIX_PRESETS,
  type AutofixPresetKey,
  INCIDENT_KIND_META,
  type Incident,
  type IncidentEventResult,
  type IncidentSeverity,
  type IncidentStatus,
} from '@nodeservice/shared';
import { CheckIcon, ChevronDownIcon, Loader2Icon, ShieldCheckIcon, WrenchIcon } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';

import { ConfirmDialog } from '@/components/confirm-dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { formatWhen } from '@/features/audit/audit-format';
import { Pill } from '@/features/settings/settings-ui';
import { apiErrorMessage } from '@/lib/api';
import { cn } from '@/lib/utils';
import {
  type IncidentsFilter,
  useAcknowledgeIncident,
  useIncidents,
  useResolveIncident,
  useRunAutofix,
} from './incidents-api';

const FILTERS: ReadonlyArray<{ key: IncidentsFilter; label: string }> = [
  { key: 'all', label: 'Все' },
  { key: 'open', label: 'Открытые' },
  { key: 'resolved', label: 'Решённые' },
];

const SEV_DOT: Record<IncidentSeverity, string> = { crit: 'bg-crit', warn: 'bg-warn', info: 'bg-text-3' };
const SEV_LABEL: Record<IncidentSeverity, string> = {
  crit: 'критично',
  warn: 'внимание',
  info: 'инфо',
};
const STATUS_PILL: Record<IncidentStatus, { tone: 'ok' | 'warn' | 'crit' | 'muted'; label: string }> = {
  open: { tone: 'crit', label: 'Открыт' },
  acknowledged: { tone: 'warn', label: 'В работе' },
  resolved: { tone: 'ok', label: 'Решён' },
};
const RESULT_DOT: Record<IncidentEventResult, string> = {
  detect: 'bg-text-3',
  notify: 'bg-text-3',
  applied: 'bg-brand',
  helped: 'bg-ok',
  resolved: 'bg-ok',
  failed: 'bg-crit',
  escalate: 'bg-warn',
};

/** Инциденты (этап 8): фильтр, карточки с таймлайном, автопочинка и ручное закрытие. */
export function IncidentsPage() {
  const [filter, setFilter] = useState<IncidentsFilter>('all');
  const [expanded, setExpanded] = useState<string | null>(null);
  const incidents = useIncidents(filter);
  const items = incidents.data?.items ?? [];

  return (
    <div className="flex flex-col gap-4">
      <fieldset className="m-0 flex h-9 w-fit items-center rounded-[10px] border border-border bg-surface p-[3px]">
        <legend className="sr-only">Фильтр инцидентов</legend>
        {FILTERS.map((f) => (
          <button
            key={f.key}
            type="button"
            aria-pressed={filter === f.key}
            onClick={() => setFilter(f.key)}
            className={cn(
              'h-full cursor-pointer rounded-[7px] px-3.5 text-[12.5px] font-medium text-text-3 transition-colors hover:text-foreground',
              filter === f.key && 'bg-surface-3 text-foreground',
            )}
          >
            {f.label}
          </button>
        ))}
      </fieldset>

      {incidents.isPending && (
        <div className="flex flex-col gap-3">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-[76px] rounded-2xl" />
          ))}
        </div>
      )}
      {incidents.isError && (
        <p className="rounded-[12px] border border-crit/30 bg-crit-soft px-4 py-3 text-[13px]">
          {apiErrorMessage(incidents.error)}{' '}
          <button type="button" className="cursor-pointer underline" onClick={() => void incidents.refetch()}>
            Повторить
          </button>
        </p>
      )}
      {incidents.data && items.length === 0 && (
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
    </div>
  );
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
  const meta = INCIDENT_KIND_META[incident.kind];
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
          <span className="mt-0.5 block truncate text-[12px] text-text-3">
            {meta.component} · {incident.serverName} ·{' '}
            {incident.status === 'resolved' && incident.resolvedAt
              ? `закрыт ${formatWhen(incident.resolvedAt)}`
              : `открыт ${formatWhen(incident.openedAt)}`}
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
  const autofix = useRunAutofix();
  const [confirmResolve, setConfirmResolve] = useState(false);

  const presets = AUTOFIX_PRESETS.filter((p) => p.kinds.includes(incident.kind));
  const canAct = incident.status !== 'resolved' && incident.serverId !== null;

  const runFix = async (preset: AutofixPresetKey) => {
    try {
      const res = await autofix.mutateAsync({ id: incident.id, preset });
      const last = res.timeline.at(-1);
      if (res.status === 'resolved') toast.success('Помогло — инцидент закрыт.');
      else if (last?.result === 'failed') toast.error('Пресет не помог — попробуй другой шаг.');
      else toast.success('Пресет применён.');
    } catch (err) {
      // StepUpCancelledError гасим тихо, остальное — тостом.
      if ((err as Error)?.name !== 'StepUpCancelledError') toast.error(apiErrorMessage(err));
    }
  };

  return (
    <div className="border-t border-border bg-surface-2/30 px-4 py-4">
      <p className="text-[13px] text-text-2">{incident.detail}</p>

      <h3 className="mt-4 mb-2 text-[11px] font-semibold tracking-[0.09em] text-text-3 uppercase">
        Что происходило
      </h3>
      <ol className="flex flex-col gap-0">
        {incident.timeline.map((e) => (
          <li key={`${e.at}-${e.result}-${e.action}`} className="flex items-start gap-3 py-1.5">
            <span className="mt-1.5 flex-none">
              <span className={cn('block size-2 rounded-full', RESULT_DOT[e.result])} aria-hidden="true" />
            </span>
            <span className="w-[64px] flex-none pt-0.5 text-[11.5px] text-text-3 tabular-nums">
              {formatWhen(e.at)}
            </span>
            <span className="min-w-0 flex-1 text-[12.5px]">
              {e.action}
              <span className="ml-1.5 text-text-3">· {e.by === 'auto' ? 'авто' : 'вручную'}</span>
            </span>
          </li>
        ))}
      </ol>

      {canAct && presets.length > 0 && (
        <div className="mt-4 rounded-[12px] border border-border-2 bg-[linear-gradient(180deg,var(--ns-brand-soft),transparent)] p-3.5">
          <div className="flex items-center gap-2 text-[12.5px] font-semibold">
            <WrenchIcon className="size-4 text-brand" aria-hidden="true" />
            Автопочинка
          </div>
          <div className="mt-2.5 flex flex-col gap-2">
            {presets.map((p) => (
              <div
                key={p.key}
                className="flex flex-wrap items-center justify-between gap-3 rounded-[10px] border border-border bg-surface px-3 py-2.5"
              >
                <div className="min-w-0">
                  <div className="text-[13px] font-semibold">{p.title}</div>
                  <div className="mt-0.5 text-[11.5px] text-text-3">{p.description}</div>
                </div>
                <button
                  type="button"
                  disabled={autofix.isPending}
                  onClick={() => void runFix(p.key)}
                  className="inline-flex h-8 flex-none cursor-pointer items-center gap-1.5 rounded-[9px] bg-cta px-3 text-[12.5px] font-semibold text-cta-foreground transition-colors hover:bg-(--ns-cta-hover) disabled:opacity-50"
                >
                  {autofix.isPending ? (
                    <Loader2Icon className="size-3.5 animate-spin" aria-hidden="true" />
                  ) : (
                    <WrenchIcon className="size-3.5" aria-hidden="true" />
                  )}
                  Применить
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {incident.status !== 'resolved' && (
        <div className="mt-4 flex flex-wrap items-center gap-2.5 border-t border-border pt-3.5">
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
