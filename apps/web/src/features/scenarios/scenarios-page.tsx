import { type Scenario, scenarioActionLabels } from '@nodeservice/shared';
import { ChevronRightIcon, GitBranchIcon, PlusIcon, Settings2Icon } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Skeleton } from '@/components/ui/skeleton';
import { useNodes } from '@/features/nodes/nodes-api';
import { Pill, Segmented, Toggle } from '@/features/settings/settings-ui';
import { apiErrorMessage } from '@/lib/api';
import { cn } from '@/lib/utils';
import { ScenarioEditor } from './scenario-editor';
import {
  Journal,
  type JournalEntry,
  JournalSkeleton,
  journalEntries,
  OUTCOME_DOT,
  runOutcome,
  when,
} from './scenario-journal';
import { conditionsPhrase, scopePhrase } from './scenario-text';
import { useSaveScenarios, useScenarioRuns, useScenarios } from './scenarios-api';

const make = (): Scenario => ({
  id: crypto.randomUUID(),
  name: 'Новый сценарий',
  enabled: false,
  scope: 'all',
  nodes: [],
  trigger: 'offline',
  // Быстро по умолчанию: условие держится минуту — и сценарий срабатывает.
  holdMinutes: 1,
  conditions: [],
  conditionMode: 'all' as const,
  actions: ['check_tcp', 'record_event'],
  renameMode: 'append',
  renameText: '',
  hostBindings: [],
  autoRestore: false,
  cooldownMinutes: 30,
});

/**
 * Шаги по порядку: номер в бирюзовом квадрате и название. Стрелка держится за шагом перед ней: при переносе
 * строка начинается с шага, а не со стрелки.
 */
function Steps({ actions }: { actions: Scenario['actions'] }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {actions.map((a, i) => (
        <span key={a} className="inline-flex items-center gap-1.5">
          <span className="inline-flex h-7 items-center gap-1.5 rounded-[9px] border border-border bg-surface pr-2.5 pl-1 text-[12.5px] whitespace-nowrap">
            <i className="grid size-5 place-items-center rounded-[6px] bg-teal text-[11px] font-extrabold text-bg not-italic">
              {i + 1}
            </i>
            {scenarioActionLabels[a]}
          </span>
          {i < actions.length - 1 && <ChevronRightIcon className="size-3.5 text-text-3" aria-hidden="true" />}
        </span>
      ))}
    </div>
  );
}

/** Последнее срабатывание сценария под его строкой: когда, на какой ноде и чем кончилось — как плашка в журнале. */
function LastRun({ rule, entries }: { rule: Scenario; entries: JournalEntry[] }) {
  const mine = entries.filter((e) => e.run.ruleId === rule.id && e.run.kind === 'run');
  const last = mine[0];
  if (!last)
    return (
      <p className="flex items-start gap-2.5 text-[12.5px] text-text-2">
        <span className="mt-1.5 size-2 flex-none rounded-full bg-text-3" aria-hidden="true" />
        <span>
          Ещё не срабатывал
          <small className="block text-[12px] text-text-3">
            {rule.enabled ? 'Сработает, когда выполнится условие' : 'Выключен — не срабатывает'}
          </small>
        </span>
      </p>
    );
  const o = runOutcome(last, rule);
  const day = mine.filter((e) => e.run.t > Date.now() - 86_400_000).length;
  return (
    <p className="flex items-start gap-2.5 text-[12.5px] leading-relaxed text-text-2">
      <span className={cn('mt-1.5 size-2 flex-none rounded-full', OUTCOME_DOT[o.tone])} aria-hidden="true" />
      <span className="min-w-0">
        <b className="font-semibold text-foreground">{when(last.run.t)}</b> · {last.run.nodeName} — {o.text}
        <small className="block text-[12px] text-text-3">срабатываний за сутки: {day}</small>
      </span>
    </p>
  );
}

function ListSkeleton() {
  return (
    <div role="status" aria-label="Загрузка сценариев">
      {[1, 2, 3].map((row) => (
        <div
          key={row}
          className="flex flex-col gap-2.5 border-t border-border px-[18px] py-3.5 first:border-t-0"
        >
          <div className="flex items-center justify-between gap-3">
            <Skeleton className="h-4 w-48" />
            <Skeleton className="h-6 w-11 rounded-full" />
          </div>
          <Skeleton className="h-3 w-2/3" />
          <div className="flex gap-2">
            <Skeleton className="h-7 w-32 rounded-[9px]" />
            <Skeleton className="h-7 w-36 rounded-[9px]" />
          </div>
          <Skeleton className="h-3 w-1/2" />
        </div>
      ))}
    </div>
  );
}
/**
 * «Сценарии» (витрина scenarios-list-2026-10, вариант C): слева список с условием фразой, шагами по порядку и
 * последним срабатыванием, справа журнал срабатываний (витрина runs, вариант B) — что сделано и чем кончилось.
 * `createSignal` — нажатие «Создать сценарий» в шапке страницы.
 */
export function ScenariosPage({ createSignal = 0 }: { createSignal?: number }) {
  const q = useScenarios(),
    save = useSaveScenarios(),
    runsQuery = useScenarioRuns(),
    nodes = useNodes();
  const [draft, setDraft] = useState<Scenario | null>(null),
    [error, setError] = useState<string | null>(null),
    [selected, setSelected] = useState<string | null>(null),
    [only, setOnly] = useState<'all' | 'one'>('all'),
    [shown, setShown] = useState(20);
  const items = q.data?.items ?? [];
  const entries = useMemo(() => journalEntries(runsQuery.data?.items ?? []), [runsQuery.data]);
  const allNodes = nodes.data?.nodes ?? [];
  const current = items.find((r) => r.id === selected) ?? items[0] ?? null;
  const journal = only === 'one' && current ? entries.filter((e) => e.run.ruleId === current.id) : entries;
  useEffect(() => {
    if (createSignal > 0) setDraft(make());
  }, [createSignal]);
  async function persist(next: Scenario[]) {
    try {
      await save.mutateAsync(next);
      setDraft(null);
      setError(null);
    } catch (e) {
      setError(apiErrorMessage(e));
    }
  }
  return (
    <div className="grid items-start gap-3 lg:grid-cols-[minmax(0,1fr)_380px]">
      <section
        className="overflow-hidden rounded-2xl border border-border bg-surface"
        aria-label="Список сценариев"
      >
        <header className="flex min-h-14 items-center gap-2.5 border-b border-border px-[18px] py-3">
          <h2 className="font-heading text-[14.5px] font-semibold">Сценарии</h2>
          {q.data && <Pill>{items.length}</Pill>}
          <span className="flex-1" />
          {q.data && (
            <span className="text-[12px] text-text-3">включено {items.filter((r) => r.enabled).length}</span>
          )}
        </header>
        {q.isPending ? (
          <ListSkeleton />
        ) : q.isError ? (
          <p role="alert" className="px-[18px] py-4 text-[13px] text-crit">
            {apiErrorMessage(q.error)}
          </p>
        ) : !items.length ? (
          <div className="grid min-h-52 place-content-center gap-2 px-6 py-8 text-center">
            <GitBranchIcon className="mx-auto size-7 text-ai" aria-hidden="true" />
            <h3 className="font-medium">Сценариев пока нет</h3>
            <p className="text-[13px] text-text-3">
              Например: при потере связи проверить TCP, изменить имя Host и написать в Telegram.
            </p>
          </div>
        ) : (
          items.map((rule) => {
            const scope = scopePhrase(rule, allNodes);
            const on = rule.id === current?.id;
            return (
              // biome-ignore lint/a11y/useSemanticElements: строка — выбор сценария для журнала, внутри свои кнопки
              <div
                key={rule.id}
                role="button"
                tabIndex={0}
                aria-pressed={on}
                aria-label={`Сценарий «${rule.name}»`}
                onClick={() => setSelected(rule.id)}
                onKeyDown={(e) => {
                  if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) {
                    e.preventDefault();
                    setSelected(rule.id);
                  }
                }}
                className={cn(
                  'grid cursor-pointer grid-cols-[minmax(0,1fr)_auto] items-start gap-x-3.5 gap-y-2.5 border-t border-border px-[18px] py-3.5 transition-colors first:border-t-0 hover:bg-surface-2/60 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-brand',
                  on && 'bg-brand/[0.06] shadow-[inset_3px_0_0_var(--ns-accent)]',
                )}
              >
                <div className="min-w-0">
                  <b className="block text-[14px] font-semibold">{rule.name}</b>
                  <p className="mt-0.5 text-[12.5px] leading-relaxed text-text-3">
                    Если <b className="font-semibold text-text-2">{conditionsPhrase(rule)}</b> держится{' '}
                    <b className="font-semibold text-text-2">{rule.holdMinutes} мин</b>{' '}
                    {scope ? (
                      <>
                        на <b className="font-semibold text-text-2">{scope}</b>
                      </>
                    ) : (
                      <b className="font-semibold text-warn">(ноды не выбраны)</b>
                    )}
                  </p>
                </div>
                {/* Переключатель и «Настроить» не выбирают строку: у них своё действие. */}
                {/* biome-ignore lint/a11y/noStaticElementInteractions: обёртка только гасит всплытие нажатия */}
                <div
                  className="flex items-center gap-2"
                  onClick={(e) => e.stopPropagation()}
                  onKeyDown={(e) => e.stopPropagation()}
                >
                  <Toggle
                    id={`scenario-on-${rule.id}`}
                    checked={rule.enabled}
                    disabled={save.isPending}
                    aria-label={`Сценарий «${rule.name}» включён`}
                    onChange={(enabled) =>
                      void persist(items.map((r) => (r.id === rule.id ? { ...r, enabled } : r)))
                    }
                  />
                  <button
                    type="button"
                    aria-label={`Настроить сценарий «${rule.name}»`}
                    onClick={() => setDraft(rule)}
                    className="grid size-9 cursor-pointer place-items-center rounded-[10px] border border-border bg-surface-2 text-text-2 transition-colors hover:bg-surface-3 hover:text-foreground"
                  >
                    <Settings2Icon className="size-4" aria-hidden="true" />
                  </button>
                </div>
                <div className="col-span-2">
                  <Steps actions={rule.actions} />
                </div>
                <div className="col-span-2">
                  {runsQuery.isPending ? (
                    <Skeleton className="h-3 w-1/2" />
                  ) : (
                    <LastRun rule={rule} entries={entries} />
                  )}
                </div>
              </div>
            );
          })
        )}
      </section>

      <section
        className="overflow-hidden rounded-2xl border border-border bg-surface"
        aria-label="Срабатывания"
      >
        <header className="flex min-h-14 items-center gap-3 border-b border-border px-[18px] py-2.5">
          <h2 className="flex-1 font-heading text-[14.5px] font-semibold">Срабатывания</h2>
          <Segmented<'all' | 'one'>
            label="Чьи срабатывания"
            value={only}
            onChange={setOnly}
            items={[
              { key: 'all', label: 'Все' },
              { key: 'one', label: 'Этот сценарий', disabled: !current },
            ]}
          />
        </header>
        {runsQuery.isPending ? (
          <JournalSkeleton />
        ) : runsQuery.isError ? (
          <p role="alert" className="px-[18px] py-4 text-[13px] text-crit">
            {apiErrorMessage(runsQuery.error)}
          </p>
        ) : !journal.length ? (
          <p className="px-[18px] py-6 text-[13px] text-text-3">
            {only === 'one' && current
              ? `«${current.name}» ещё не срабатывал.`
              : 'Срабатываний пока нет — сценарии сработают, когда выполнится условие.'}
          </p>
        ) : (
          // Имя сценария в записи нужно, только когда в «Все» сценариев несколько.
          <Journal
            entries={journal.slice(0, shown)}
            rules={items}
            showRule={only === 'all' && items.length > 1}
          />
        )}
        {journal.length > shown && (
          <div className="border-t border-border px-[18px] py-3">
            <button
              type="button"
              onClick={() => setShown((n) => n + 20)}
              className="h-10 w-full cursor-pointer rounded-[10px] border border-border bg-surface-2 text-[13px] font-medium text-text-2 transition-colors hover:text-foreground"
            >
              Показать ещё {Math.min(20, journal.length - shown)}
            </button>
          </div>
        )}
      </section>

      {error && (
        <p role="alert" className="text-[13px] text-crit lg:col-span-2">
          {error}
        </p>
      )}
      {draft && (
        <ScenarioEditor
          draft={draft}
          setDraft={setDraft}
          busy={save.isPending}
          onClose={() => setDraft(null)}
          // Правленый сценарий остаётся на своём месте в списке, новый — в конце.
          onSave={() =>
            void persist(
              items.some((r) => r.id === draft.id)
                ? items.map((r) => (r.id === draft.id ? draft : r))
                : [...items, draft],
            )
          }
          onDelete={
            items.some((r) => r.id === draft.id)
              ? () => void persist(items.filter((r) => r.id !== draft.id))
              : undefined
          }
          error={error}
        />
      )}
    </div>
  );
}

/** Кнопка «Создать сценарий» в шапке страницы: недоступна, пока Remnawave не подключена. */
export function CreateScenarioButton({ onClick }: { onClick: () => void }) {
  const nodes = useNodes();
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!nodes.data?.connected}
      className="inline-flex h-10 cursor-pointer items-center gap-1.5 rounded-[10px] bg-cta px-4 text-[13px] font-semibold text-cta-foreground transition-colors hover:bg-(--ns-cta-hover) disabled:cursor-default disabled:opacity-50"
    >
      <PlusIcon className="size-4" aria-hidden="true" />
      Создать сценарий
    </button>
  );
}
