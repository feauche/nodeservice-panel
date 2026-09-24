import { INCIDENT_KIND_META, type Incident, type IncidentStatus } from '@nodeservice/shared';
import { Link } from '@tanstack/react-router';
import { ChevronRightIcon, Trash2Icon, WrenchIcon } from 'lucide-react';
import { useMemo, useState } from 'react';

import { ConfirmDialog } from '@/components/confirm-dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { Pill } from '@/features/settings/settings-ui';
import { apiErrorMessage } from '@/lib/api';
import { toast } from '@/lib/notify';
import { useNow } from '@/lib/use-now';
import { cn } from '@/lib/utils';
import { dayLabel, durationText, hhmm, outcomeSentence, weekStats } from './incident-format';
import { type IncidentsFilter, useDeleteResolvedIncidents, useIncidents } from './incidents-api';
import { LevelChip } from './level-chip';

const FILTERS: ReadonlyArray<{ key: IncidentsFilter; label: string }> = [
  { key: 'all', label: 'Все' },
  { key: 'open', label: 'Открытые' },
  { key: 'resolved', label: 'Решённые' },
];
const STATUS_PILL: Record<IncidentStatus, { tone: 'ok' | 'warn' | 'crit' | 'muted'; label: string }> = {
  open: { tone: 'crit', label: 'Открыт' },
  acknowledged: { tone: 'warn', label: 'В работе' },
  resolved: { tone: 'ok', label: 'Решён' },
};

/** Цвет полоски слева: итог инцидента одним взглядом. */
function barTone(inc: Incident): string {
  if (inc.status !== 'resolved') return inc.severity === 'crit' ? 'bg-crit' : 'bg-warn';
  const helped = inc.attempts.some((a) => a.status === 'helped');
  if (helped || inc.resolvedBy === 'auto') return 'bg-ok';
  return 'bg-border-2';
}

/**
 * «Инциденты» (витрина v3, A1): полоса итога за 7 дней и реестр по дням — время, сервер, что случилось
 * и чем кончилось одним предложением, статус, длительность. Строка ведёт на страницу-кейс.
 */
export function IncidentsPage() {
  const [filter, setFilter] = useState<IncidentsFilter>('all');
  const incidents = useIncidents('all');
  const all = incidents.data?.items ?? [];
  const anyOpen = all.some((i) => i.status !== 'resolved');
  const now = useNow(anyOpen, 1000);
  const deleteResolved = useDeleteResolvedIncidents();
  const [confirmClear, setConfirmClear] = useState(false);

  const items = useMemo(
    () =>
      filter === 'open'
        ? all.filter((i) => i.status !== 'resolved')
        : filter === 'resolved'
          ? all.filter((i) => i.status === 'resolved')
          : all,
    [all, filter],
  );
  const openCount = all.filter((i) => i.status !== 'resolved').length;
  const stats = useMemo(() => weekStats(all, now), [all, now]);

  // Группы: открытые под «Сейчас», решённые — по дню открытия.
  const groups = useMemo(() => {
    const out: Array<{ key: string; label: string; note?: string; items: Incident[] }> = [];
    const open = items.filter((i) => i.status !== 'resolved');
    if (open.length > 0) out.push({ key: 'now', label: 'Сейчас', items: open });
    const byDay = new Map<string, Incident[]>();
    for (const inc of items.filter((i) => i.status === 'resolved')) {
      const label = dayLabel(inc.openedAt, now);
      byDay.set(label, [...(byDay.get(label) ?? []), inc]);
    }
    for (const [label, list] of byDay) {
      const auto = list.filter((i) =>
        i.attempts.some((a) => a.status === 'helped' && a.by === 'auto'),
      ).length;
      const n = list.length;
      const word = n === 1 ? 'сбой' : n < 5 ? 'сбоя' : 'сбоев';
      out.push({
        key: label,
        label,
        note: auto === n ? `${n} ${word} · все починились сами` : `${n} ${word}`,
        items: list,
      });
    }
    return out;
  }, [items, now]);

  if (incidents.isPending)
    return (
      <div className="flex flex-col gap-4">
        <Skeleton className="h-[60px] rounded-2xl" />
        <Skeleton className="h-[320px] rounded-2xl" />
      </div>
    );
  if (incidents.isError)
    return (
      <p
        role="alert"
        className="rounded-[12px] border border-crit/30 bg-crit-soft px-4 py-3 text-[13px] text-crit"
      >
        {apiErrorMessage(incidents.error)}
      </p>
    );

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
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
        <span className="flex-1" />
        {filter === 'resolved' && items.length > 0 && (
          <button
            type="button"
            disabled={deleteResolved.isPending}
            onClick={() => setConfirmClear(true)}
            className="inline-flex h-9 cursor-pointer items-center gap-1.5 rounded-[10px] border border-border bg-surface px-3.5 text-[12.5px] font-medium text-text-2 transition-colors hover:bg-surface-3 hover:text-foreground disabled:opacity-50"
          >
            <Trash2Icon className="size-3.5" aria-hidden="true" />
            Удалить решённые
          </button>
        )}
        <Link
          to="/incidents/autofix"
          className="inline-flex h-9 items-center gap-1.5 rounded-[10px] border border-border bg-surface px-3.5 text-[12.5px] font-medium text-text-2 transition-colors hover:bg-surface-3 hover:text-foreground"
        >
          <WrenchIcon className="size-3.5" aria-hidden="true" />
          Автопочинка
        </Link>
      </div>

      <StatsStrip stats={stats} />

      {items.length === 0 ? (
        <div className="grid place-items-center rounded-2xl border border-dashed border-border-2 px-6 py-16 text-center">
          <div className="text-[14px] font-semibold">Пока спокойно</div>
          <div className="mt-1 text-[12.5px] text-text-3">
            {filter === 'resolved'
              ? 'Решённых инцидентов нет.'
              : 'Сбоев не зафиксировано. Как только что-то случится, оно появится здесь.'}
          </div>
        </div>
      ) : (
        <div className="overflow-hidden rounded-2xl border border-border bg-surface">
          {groups.map((g) => (
            <section key={g.key} aria-label={g.label}>
              <h2 className="flex items-baseline gap-2.5 border-t border-border px-4 pt-2.5 pb-1.5 text-[12px] text-text-3 first:border-t-0">
                <span className="text-[12.5px] font-semibold text-text-2">{g.label}</span>
                {g.note && <span>{g.note}</span>}
              </h2>
              {g.items.map((inc) => (
                <IncidentRow key={inc.id} inc={inc} now={now} />
              ))}
            </section>
          ))}
        </div>
      )}

      <ConfirmDialog
        open={confirmClear}
        onOpenChange={setConfirmClear}
        kind="crit"
        title="Удалить все решённые инциденты?"
        description="История починок по ним пропадёт, статистика «помогло N из M» пересчитается. Открытые инциденты останутся. Записи Журнала не трогаем."
        yesLabel="Удалить"
        loading={deleteResolved.isPending}
        onConfirm={async () => {
          try {
            const { deleted } = await deleteResolved.mutateAsync();
            setConfirmClear(false);
            toast.success(deleted > 0 ? `Удалено инцидентов: ${deleted}.` : 'Решённых инцидентов не было.');
          } catch (err) {
            setConfirmClear(false);
            toast.error(apiErrorMessage(err));
          }
        }}
      />
    </div>
  );
}

/** Полоса итога за 7 дней: числа словами, без KPI-плиток. */
function StatsStrip({ stats }: { stats: ReturnType<typeof weekStats> }) {
  const resolved = stats.auto + stats.waited + stats.manual;
  const pct = (n: number) => (resolved > 0 ? `${(n / resolved) * 100}%` : '0%');
  const avg =
    stats.avgFixS === null
      ? null
      : stats.avgFixS < 60
        ? `${stats.avgFixS} с`
        : `${Math.round(stats.avgFixS / 60)} мин`;
  return (
    <div
      data-testid="incidents-stats"
      className="flex flex-wrap items-center gap-x-6 gap-y-2 rounded-2xl border border-border bg-surface px-4 py-3"
    >
      <Stat n={stats.total} label="сбоев за 7 дней" />
      <span className="hidden h-7 w-px bg-border sm:block" aria-hidden="true" />
      <Stat n={stats.auto} label="починились сами" cls="text-ok" />
      <Stat n={stats.waited} label="ждали подтверждения" cls="text-warn" />
      <Stat n={stats.manual} label="закрыты вручную" />
      {stats.open > 0 && <Stat n={stats.open} label="открыто сейчас" cls="text-crit" />}
      <div className="flex min-w-[120px] flex-1 items-center gap-3">
        <div className="flex h-2 flex-1 overflow-hidden rounded-full bg-surface-3" aria-hidden="true">
          <span className="h-full bg-ok" style={{ width: pct(stats.auto) }} />
          <span className="h-full bg-warn" style={{ width: pct(stats.waited) }} />
          <span className="h-full bg-border-2" style={{ width: pct(stats.manual) }} />
        </div>
        {avg && (
          <span className="text-[12px] whitespace-nowrap text-text-3">Среднее время починки {avg}</span>
        )}
      </div>
    </div>
  );
}

function Stat({ n, label, cls }: { n: number; label: string; cls?: string }) {
  return (
    <div className="flex flex-col leading-tight">
      <b className={cn('font-heading text-[19px] font-bold tracking-[-0.02em] tabular-nums', cls)}>{n}</b>
      <span className="text-[11.5px] text-text-3">{label}</span>
    </div>
  );
}

function IncidentRow({ inc, now }: { inc: Incident; now: number }) {
  const status = STATUS_PILL[inc.status];
  const level =
    inc.attempts.find((a) => a.status === 'running')?.level ??
    inc.proposal?.level ??
    inc.attempts.at(-1)?.level;
  return (
    <Link
      to="/incidents/$id"
      params={{ id: inc.id }}
      data-testid="incident-row"
      className="grid grid-cols-[3px_52px_minmax(0,1fr)_auto] items-center gap-x-3 border-t border-border py-2.5 pr-3 transition-colors hover:bg-surface-2 md:grid-cols-[3px_56px_170px_minmax(0,1fr)_auto_84px] md:gap-x-4"
    >
      <span className={cn('h-full min-h-9 w-[3px] rounded-r-[2px]', barTone(inc))} aria-hidden="true" />
      <span className="text-[12.5px] text-text-3 tabular-nums">{hhmm(inc.openedAt)}</span>
      <span className="hidden truncate text-[13px] font-semibold md:block">{inc.serverName}</span>
      <span className="min-w-0">
        <span className="block text-[13px] font-semibold max-md:line-clamp-2 md:truncate">
          {INCIDENT_KIND_META[inc.kind].label}
        </span>
        <span className="block text-[12.5px] text-text-3 md:hidden">{inc.serverName}</span>
        <span className="block text-[12.5px] text-text-2 max-md:line-clamp-2 md:truncate">
          {outcomeSentence(inc, now)}
        </span>
      </span>
      <span className="flex items-center gap-1.5 max-md:self-start">
        <Pill tone={status.tone}>{status.label}</Pill>
        {level && <LevelChip level={level} />}
        <ChevronRightIcon className="size-4 text-text-3 md:hidden" aria-hidden="true" />
      </span>
      <span className="hidden text-right text-[12.5px] text-text-3 tabular-nums md:block">
        {durationText(inc, now)}
      </span>
    </Link>
  );
}
