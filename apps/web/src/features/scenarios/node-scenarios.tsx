import type { Scenario } from '@nodeservice/shared';
import { Link } from '@tanstack/react-router';
import { ChevronRightIcon, GitBranchIcon, PlusIcon } from 'lucide-react';
import { Skeleton } from '@/components/ui/skeleton';
import { Toggle } from '@/features/settings/settings-ui';
import { apiErrorMessage } from '@/lib/api';
import { toast } from '@/lib/notify';
import { RunList } from './scenario-journal';
import { conditionsPhrase } from './scenario-text';
import { useSaveScenarios, useScenarioJournal, useScenarios } from './scenarios-api';
import { StepIcons } from './scenarios-page';

const LINK_BTN =
  'inline-flex h-10 w-fit items-center gap-1.5 rounded-[10px] border border-border bg-surface px-3.5 text-[13px] font-medium text-text-2 transition-colors hover:bg-surface-2 hover:text-foreground';

/** Последние три срабатывания сценария на этой ноде — или «ещё не срабатывал». */
function NodeRuns({ rule, node }: { rule: Scenario; node: string }) {
  const q = useScenarioJournal({ rule: rule.id, node, tone: [], period: '30d' });
  if (q.isPending) return <Skeleton className="h-[46px] rounded-[12px]" />;
  if (q.isError)
    return (
      <p role="alert" className="text-[12.5px] text-crit">
        {apiErrorMessage(q.error)}
      </p>
    );
  const first = q.data.pages[0];
  const items = first?.items.slice(0, 3) ?? [];
  if (!items.length) return <p className="text-[12.5px] text-text-3">На этой ноде ещё не срабатывал.</p>;
  return <RunList items={items} rule={rule} timeZone={first?.timeZone ?? 'UTC'} />;
}

/**
 * Вкладка «Автоматизация» окна ноды (витрина scenarios-2026-10b, вариант D, как у референса): сценарии, которые
 * действуют на эту ноду, и что они на ней делали. Переключатель включает сценарий целиком; настраиваются сценарии
 * на странице «Сценарии» — туда ведут ссылки.
 */
export function NodeScenarios({ uuid }: { uuid: string }) {
  const q = useScenarios();
  const save = useSaveScenarios();
  if (q.isPending)
    return (
      <div role="status" aria-label="Загрузка сценариев ноды" className="flex flex-col gap-3">
        {[0, 1].map((i) => (
          <Skeleton key={i} className="h-[150px] rounded-2xl" />
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
    <div className="flex flex-col gap-3">
      <p className="text-[13px] text-text-3">
        Сценарии, которые действуют на эту ноду, и что они на ней делали. Настраиваются на странице
        «Сценарии».
      </p>
      {!items.length ? (
        <p className="rounded-2xl border border-dashed border-border px-4 py-6 text-center text-[13px] text-text-3">
          Сценариев для этой ноды пока нет: ни общих, ни выбранных для неё.
        </p>
      ) : (
        items.map((r) => (
          <section
            key={r.id}
            className="flex flex-col gap-3 rounded-2xl border border-border bg-surface px-4 py-3.5"
          >
            <header className="flex items-start gap-3">
              <span className="grid size-9 flex-none place-items-center rounded-[10px] bg-ai-soft text-ai">
                <GitBranchIcon className="size-4" aria-hidden="true" />
              </span>
              <div className="min-w-0 flex-1">
                <b className="block truncate text-[14px] font-semibold">{r.name}</b>
                <span className="mt-0.5 block text-[12.5px] text-text-3">
                  <b className="font-semibold text-text-2">{conditionsPhrase(r)}</b> · держится{' '}
                  {r.holdMinutes} мин · {r.scope === 'all' ? 'общий для всех нод' : 'выбран для этой ноды'}
                </span>
              </div>
              <span className="flex h-10 flex-none items-center gap-2.5 rounded-[10px] border border-border px-3">
                <span className="text-[13px] text-text-2 max-sm:hidden">
                  {r.enabled ? 'Включён' : 'Выключен'}
                </span>
                <Toggle
                  id={`node-scenario-${r.id}`}
                  checked={r.enabled}
                  disabled={save.isPending}
                  aria-label={`Сценарий «${r.name}»${r.scope === 'all' ? ' для всех нод' : ''}`}
                  onChange={(enabled) => toggle(r.id, enabled)}
                />
              </span>
            </header>
            <StepIcons actions={r.actions} />
            <NodeRuns rule={r} node={uuid} />
            <Link
              to="/scenarios"
              search={{ open: r.id, tab: 'runs', node: uuid }}
              className="inline-flex w-fit items-center gap-1 text-[12.5px] font-medium text-brand hover:underline"
            >
              Все срабатывания сценария на этой ноде
              <ChevronRightIcon className="size-3.5" aria-hidden="true" />
            </Link>
          </section>
        ))
      )}
      <Link to="/scenarios" search={{ create: 1, node: uuid }} className={LINK_BTN}>
        <PlusIcon className="size-4" aria-hidden="true" />
        Сценарий для этой ноды
      </Link>
    </div>
  );
}
