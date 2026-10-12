import { scenarioActionLabels, scenarioConditionLabel } from '@nodeservice/shared';
import { Link } from '@tanstack/react-router';
import { ArrowUpRightIcon, ChevronRightIcon } from 'lucide-react';
import { Skeleton } from '@/components/ui/skeleton';
import { Pill, Toggle } from '@/features/settings/settings-ui';
import { apiErrorMessage } from '@/lib/api';
import { toast } from '@/lib/notify';
import { useSaveScenarios, useScenarios } from './scenarios-api';

/** Сценарии, которые касаются ноды: общие и выбранные для неё. Переключатель включает сценарий целиком. */
export function NodeScenarios({ uuid }: { uuid: string }) {
  const q = useScenarios();
  const save = useSaveScenarios();
  if (q.isPending)
    return (
      <div role="status" aria-label="Загрузка сценариев ноды" className="flex flex-col gap-2.5">
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-[68px] rounded-2xl" />
        ))}
      </div>
    );
  if (q.isError)
    return (
      <p role="alert" className="text-[13px] text-crit">
        {apiErrorMessage(q.error)}
      </p>
    );
  const all = q.data?.items ?? [];
  const items = all.filter((r) => r.scope === 'all' || r.nodes.includes(uuid));
  const toggle = (id: string, enabled: boolean) =>
    save.mutate(
      all.map((r) => (r.id === id ? { ...r, enabled } : r)),
      { onError: (err) => toast.error(apiErrorMessage(err)) },
    );
  return (
    <div className="flex flex-col gap-2.5">
      {!items.length ? (
        <p className="rounded-2xl border border-dashed border-border px-4 py-6 text-center text-[13px] text-text-3">
          Сценариев для этой ноды пока нет: ни общих, ни выбранных для неё.
        </p>
      ) : (
        items.map((r) => (
          <div
            key={r.id}
            className="flex items-center gap-3.5 rounded-2xl border border-border bg-surface px-4 py-3.5"
          >
            <Toggle
              id={`node-scenario-${r.id}`}
              checked={r.enabled}
              disabled={save.isPending}
              aria-label={`Сценарий «${r.name}»${r.scope === 'all' ? ' для всех нод' : ''}`}
              onChange={(enabled) => toggle(r.id, enabled)}
            />
            <div className="min-w-0 flex-1">
              <b className="block truncate text-[14px] font-semibold">{r.name}</b>
              <span className="mt-[3px] block text-[12px] text-text-3">
                {scenarioConditionLabel(r)} · {r.holdMinutes} мин ·{' '}
                {r.scope === 'all' ? 'общий для всех нод' : 'выбран для этой ноды'}
              </span>
            </div>
            <div className="flex max-w-[45%] flex-wrap justify-end gap-1.5 max-md:hidden">
              {r.actions.map((a) => (
                <Pill key={a}>{scenarioActionLabels[a]}</Pill>
              ))}
            </div>
            <Link
              to="/scenarios"
              aria-label={`Открыть сценарий «${r.name}» в разделе «Сценарии»`}
              className="grid size-8 flex-none place-items-center rounded-[9px] text-text-3 hover:bg-surface-2 hover:text-foreground"
            >
              <ChevronRightIcon className="size-4" aria-hidden="true" />
            </Link>
          </div>
        ))
      )}
      <Link
        to="/scenarios"
        className="inline-flex h-9 w-fit items-center gap-1.5 rounded-[10px] border border-border bg-surface px-3.5 text-[12.5px] font-medium text-text-2 transition-colors hover:bg-surface-2 hover:text-foreground"
      >
        <ArrowUpRightIcon className="size-3.5" aria-hidden="true" />
        Открыть «Сценарии»
      </Link>
    </div>
  );
}
