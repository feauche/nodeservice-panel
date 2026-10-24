import type { RunTone, Scenario, ScenarioOverview } from '@nodeservice/shared';
import { ChevronRightIcon, GitBranchIcon, PlusIcon, SearchIcon } from 'lucide-react';
import { useEffect, useState } from 'react';
import { KpiCard, KpiCardSkeleton } from '@/components/kpi-card';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { useNodes } from '@/features/nodes/nodes-api';
import { Segmented, Toggle } from '@/features/settings/settings-ui';
import { apiErrorMessage } from '@/lib/api';
import { cn, randomId } from '@/lib/utils';
import { type EditorTab, ScenarioEditor, STEPS } from './scenario-editor';
import { OUTCOME_DOT, RunStrip, RunsPanel, when } from './scenario-journal';
import { conditionsPhrase, scopePhrase } from './scenario-text';
import { useSaveScenarios, useScenarioOverview, useScenarios } from './scenarios-api';

/** Адрес страницы: открыть сценарий (из окна ноды — на срабатываниях этой ноды) или создать новый для ноды. */
export type ScenariosSearch = { open?: string; tab?: EditorTab; node?: string; create?: 1 };

const make = (over: Partial<Scenario> = {}): Scenario => ({
  id: randomId(),
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
  autoRestore: true,
  cooldownMinutes: 30,
  dpiEveryMinutes: 120,
  dpiDailyUsd: 1,
  switchEveryHours: 24,
  switchDns: true,
  except: [],
  ...over,
});

/** Готовые сценарии для пустой страницы: условие и шаги уже выбраны — остаётся проверить и сохранить. */
const TEMPLATES: Array<{ title: string; text: string; make: () => Scenario }> = [
  {
    title: 'Нода потеряла связь — отключить Host',
    text: 'Клиенты не попадают на упавшую ноду: Host отключается и возвращается, когда нода снова на связи.',
    make: () =>
      make({
        name: 'Нода потеряла связь — отключить Host',
        trigger: 'offline',
        actions: ['record_event', 'hide_host', 'notify'],
      }),
  },
  {
    title: 'Падение онлайна — пометить Host',
    text: 'Проверить TCP, записать в событие, поставить ⚠️ в имя Host и написать в Telegram.',
    make: () =>
      make({
        name: 'Падение онлайна — пометить Host',
        trigger: 'online_drop',
        actions: ['check_tcp', 'record_event', 'rename_host', 'notify'],
        renameText: '⚠️',
      }),
  },
  {
    title: 'Блокировка из РФ — предупредить',
    text: 'Когда TCP недоступен из РФ, прислать сообщение в Telegram с таблицей портов.',
    make: () =>
      make({
        name: 'Блокировка из РФ — предупредить',
        trigger: 'tcp_unreachable',
        holdMinutes: 5,
        actions: ['check_tcp', 'notify'],
      }),
  },
];

/** Сутки по 2 часа: столбик — худший итог в промежутке, пустой — срабатываний не было. */
function DayBars({ slots }: { slots: ReadonlyArray<RunTone | null> }) {
  const color: Record<RunTone, string> = { ok: 'bg-ok', warn: 'bg-warn', crit: 'bg-crit', teal: 'bg-teal' };
  return (
    <div className="flex h-9 items-end gap-[3px]" aria-hidden="true">
      {slots.map((tone, i) => (
        <i
          // biome-ignore lint/suspicious/noArrayIndexKey: промежуток суток — постоянный порядок
          key={i}
          className={cn('block h-[30px] w-[7px] rounded-[2px]', tone ? color[tone] : 'bg-surface-3')}
        />
      ))}
    </div>
  );
}

/** Плитки сверху (витрина scenarios-2026-10b, страница A): что включено, сколько срабатываний, замечания, Host. */
function Tiles({ o }: { o: ScenarioOverview | undefined }) {
  if (!o)
    return (
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <KpiCardSkeleton key={i} />
        ))}
      </div>
    );
  const t = o.tiles;
  const remarks = t.weekWarn + t.weekCrit;
  return (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      <KpiCard
        label="Включено"
        value={t.enabled}
        unit={`из ${t.total}`}
        status={t.enabled ? 'работают сами' : t.total ? 'все выключены' : 'сценариев пока нет'}
        tone={t.enabled ? 'ok' : 'muted'}
      />
      <KpiCard
        label="Срабатываний за сутки"
        value={t.day}
        status={t.day ? 'по 2 часа' : 'не срабатывали'}
        tone={t.day ? 'info' : 'muted'}
        extra={<DayBars slots={t.daySlots} />}
      />
      <KpiCard
        label="С замечаниями за 7 дней"
        value={<span className={cn(remarks > 0 && 'text-warn')}>{remarks}</span>}
        unit={`из ${t.week}`}
        status={remarks ? `${t.weekCrit} не вышло · ${t.weekWarn} с замечанием` : 'замечаний не было'}
        tone={t.weekCrit ? 'crit' : remarks ? 'warn' : 'ok'}
      />
      <KpiCard
        label="Host помечен сейчас"
        value={t.marked}
        status={t.marked ? 'вернётся сам после восстановления' : 'помеченных Host нет'}
        tone={t.marked ? 'info' : 'ok'}
      />
    </div>
  );
}

/** Шаги значками по порядку — подсказка с названием шага при наведении. */
export function StepIcons({ actions }: { actions: Scenario['actions'] }) {
  return (
    <span
      className="flex items-center gap-1"
      role="img"
      aria-label={`Шаги: ${actions.map((a) => STEPS[a].title).join(', ')}`}
    >
      {actions.map((a, i) => {
        const Icon = STEPS[a].icon;
        return (
          <span key={a} className="flex items-center gap-1">
            <i
              title={`${i + 1}. ${STEPS[a].title}`}
              className="grid size-8 place-items-center rounded-[9px] bg-teal/12 text-teal not-italic"
            >
              <Icon className="size-4" aria-hidden="true" />
            </i>
            {i < actions.length - 1 && <ChevronRightIcon className="size-3 text-text-3" aria-hidden="true" />}
          </span>
        );
      })}
    </span>
  );
}

function ListSkeleton() {
  return (
    <div role="status" aria-label="Загрузка сценариев">
      {[1, 2, 3].map((row) => (
        <div key={row} className="flex items-center gap-4 border-t border-border px-4 py-4 first:border-t-0">
          <Skeleton className="h-6 w-11 rounded-full" />
          <div className="flex flex-1 flex-col gap-2">
            <Skeleton className="h-4 w-56" />
            <Skeleton className="h-3 w-2/3" />
          </div>
          <Skeleton className="h-8 w-40 rounded-[9px] max-lg:hidden" />
          <Skeleton className="h-8 w-48 max-lg:hidden" />
        </div>
      ))}
    </div>
  );
}

type ListFilter = 'all' | 'on' | 'off' | 'warn';
type Editing = { draft: Scenario; original: Scenario | null; tab: EditorTab; node?: string };

/**
 * «Сценарии» (витрина scenarios-2026-10b, страница A): плитки сверху, вкладки «Сценарии | Журнал срабатываний»,
 * сценарий — строкой (условие, шаги значками, последнее срабатывание, полоска последних 20). Срабатывания одного
 * сценария — в его окне, всех — во вкладке «Журнал», порциями. `createSignal` — «Создать сценарий» в шапке.
 */
export function ScenariosPage({
  createSignal = 0,
  search = {},
  clearSearch,
}: {
  createSignal?: number;
  search?: ScenariosSearch;
  clearSearch?: () => void;
}) {
  const q = useScenarios(),
    save = useSaveScenarios(),
    overview = useScenarioOverview(),
    nodes = useNodes();
  const [editing, setEditing] = useState<Editing | null>(null),
    [error, setError] = useState<string | null>(null),
    [tab, setTab] = useState<'list' | 'journal'>('list'),
    [filter, setFilter] = useState<ListFilter>('all'),
    [query, setQuery] = useState('');
  const items = q.data?.items ?? [];
  const allNodes = nodes.data?.nodes ?? [];
  const stats = new Map((overview.data?.items ?? []).map((i) => [i.ruleId, i]));
  useEffect(() => {
    if (createSignal > 0) setEditing({ draft: make(), original: null, tab: 'rule' });
  }, [createSignal]);
  // Переход по ссылке из окна ноды: открыть сценарий или новый — для этой ноды; адрес после этого очищается.
  useEffect(() => {
    if (!q.data) return;
    if (search.create) {
      setEditing({
        draft: make(search.node ? { scope: 'selected', nodes: [search.node] } : {}),
        original: null,
        tab: 'rule',
      });
      clearSearch?.();
    } else if (search.open) {
      const rule = q.data.items.find((r) => r.id === search.open);
      if (rule)
        setEditing({
          draft: rule,
          original: rule,
          tab: search.tab ?? 'rule',
          ...(search.node ? { node: search.node } : {}),
        });
      clearSearch?.();
    }
  }, [q.data, search.create, search.open, search.tab, search.node, clearSearch]);

  async function persist(next: Scenario[], close = true) {
    try {
      await save.mutateAsync(next);
      if (close) setEditing(null);
      setError(null);
      return true;
    } catch (e) {
      setError(apiErrorMessage(e));
      return false;
    }
  }
  const remarked = (r: Scenario) => (stats.get(r.id)?.dayWarn ?? 0) > 0;
  const counts = {
    on: items.filter((r) => r.enabled).length,
    off: items.filter((r) => !r.enabled).length,
    warn: items.filter(remarked).length,
  };
  const needle = query.trim().toLowerCase();
  const shown = items.filter(
    (r) =>
      (filter === 'all' ||
        (filter === 'on' && r.enabled) ||
        (filter === 'off' && !r.enabled) ||
        (filter === 'warn' && remarked(r))) &&
      (!needle || `${r.name} ${conditionsPhrase(r)}`.toLowerCase().includes(needle)),
  );
  const open = (rule: Scenario, editorTab: EditorTab = 'rule') =>
    setEditing({ draft: rule, original: rule, tab: editorTab });

  return (
    <div className="flex flex-col gap-3">
      <Tiles o={overview.data} />
      <section className="overflow-hidden rounded-2xl border border-border bg-surface" aria-label="Сценарии">
        <header className="flex flex-wrap items-center gap-2.5 border-b border-border px-4 py-3">
          <Segmented<'list' | 'journal'>
            label="Что показать"
            value={tab}
            onChange={setTab}
            items={[
              { key: 'list', label: `Сценарии${q.data ? ` · ${items.length}` : ''}` },
              { key: 'journal', label: 'Журнал срабатываний' },
            ]}
          />
          {tab === 'list' && (
            <>
              <Segmented<ListFilter>
                label="Какие сценарии"
                value={filter}
                onChange={setFilter}
                items={[
                  { key: 'all', label: 'Все' },
                  { key: 'on', label: `Включены · ${counts.on}` },
                  { key: 'off', label: `Выключены · ${counts.off}` },
                  {
                    key: 'warn',
                    label: `С замечаниями · ${counts.warn}`,
                    title: 'Замечание или ошибка за сутки',
                  },
                ]}
              />
              <div className="relative ml-auto w-[260px] max-md:ml-0 max-md:w-full">
                <SearchIcon
                  className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-text-3"
                  aria-hidden="true"
                />
                <Input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Найти сценарий"
                  aria-label="Найти сценарий"
                  className="h-10 pl-9"
                />
              </div>
            </>
          )}
        </header>

        {tab === 'journal' ? (
          <div className="p-4">
            <RunsPanel
              rules={items}
              nodes={allNodes}
              emptyText="Срабатываний за этот период нет — сценарии сработают, когда выполнится условие."
            />
          </div>
        ) : q.isPending ? (
          <ListSkeleton />
        ) : q.isError ? (
          <p role="alert" className="px-4 py-4 text-[13px] text-crit">
            {apiErrorMessage(q.error)}
          </p>
        ) : !items.length ? (
          <div className="flex flex-col items-center gap-4 px-6 py-10 text-center">
            <span className="grid size-11 place-items-center rounded-full bg-ai-soft text-ai">
              <GitBranchIcon className="size-5" aria-hidden="true" />
            </span>
            <div>
              <h3 className="font-heading text-[16px] font-semibold">Сценариев пока нет</h3>
              <p className="mt-1 text-[13px] text-text-3">
                Сценарий сам выполнит шаги, когда с нодой что-то случится. Начните с готового:
              </p>
            </div>
            <div className="grid w-full max-w-[920px] gap-3 md:grid-cols-3">
              {TEMPLATES.map((t) => (
                <button
                  key={t.title}
                  type="button"
                  onClick={() => setEditing({ draft: t.make(), original: null, tab: 'rule' })}
                  className="flex cursor-pointer flex-col gap-1.5 rounded-2xl border border-border bg-surface-2 p-4 text-left transition-colors hover:border-ai/50 hover:bg-surface-3"
                >
                  <b className="text-[13.5px] font-semibold">{t.title}</b>
                  <span className="text-[12.5px] leading-relaxed text-text-3">{t.text}</span>
                </button>
              ))}
            </div>
          </div>
        ) : !shown.length ? (
          <p className="px-4 py-8 text-center text-[13px] text-text-3">По этому отбору сценариев нет.</p>
        ) : (
          <ul>
            {shown.map((rule) => {
              const scope = scopePhrase(rule, allNodes);
              const st = stats.get(rule.id);
              return (
                <li key={rule.id} className="border-t border-border first:border-t-0">
                  {/* biome-ignore lint/a11y/useSemanticElements: строка — открытие окна, внутри свой переключатель */}
                  <div
                    role="button"
                    tabIndex={0}
                    aria-label={`Открыть сценарий «${rule.name}»`}
                    onClick={() => open(rule)}
                    onKeyDown={(e) => {
                      if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) {
                        e.preventDefault();
                        open(rule);
                      }
                    }}
                    className="grid cursor-pointer grid-cols-[44px_minmax(0,1fr)_auto_190px_190px_16px] items-center gap-x-4 px-4 py-3.5 transition-colors hover:bg-surface-2/60 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-brand max-xl:grid-cols-[44px_minmax(0,1fr)_190px_16px] max-md:grid-cols-[44px_minmax(0,1fr)_16px]"
                  >
                    {/* Переключатель не открывает окно: у него своё действие. */}
                    {/* biome-ignore lint/a11y/noStaticElementInteractions: обёртка только гасит всплытие нажатия */}
                    <span onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
                      <Toggle
                        id={`scenario-on-${rule.id}`}
                        checked={rule.enabled}
                        disabled={save.isPending}
                        aria-label={`Сценарий «${rule.name}» включён`}
                        onChange={(enabled) =>
                          void persist(
                            items.map((r) => (r.id === rule.id ? { ...r, enabled } : r)),
                            false,
                          )
                        }
                      />
                    </span>
                    <span className="min-w-0">
                      <span className="flex items-center gap-2">
                        <b className="truncate text-[14px] font-semibold">{rule.name}</b>
                        {!rule.enabled && (
                          <span className="rounded-full bg-surface-3 px-2 py-0.5 text-[11px] font-semibold text-text-3">
                            Выключен
                          </span>
                        )}
                      </span>
                      <span className="mt-0.5 line-clamp-2 text-[12.5px] leading-relaxed text-text-3">
                        <b className="font-semibold text-text-2">{conditionsPhrase(rule)}</b> · держится{' '}
                        {rule.holdMinutes} мин ·{' '}
                        {scope ?? <span className="font-semibold text-warn">ноды не выбраны</span>}
                        {(rule.except ?? []).includes('wave') && ' · кроме нод в волне'}
                      </span>
                    </span>
                    <span className="max-xl:hidden">
                      <StepIcons actions={rule.actions} />
                    </span>
                    <span className="min-w-0 text-[12.5px] max-md:hidden">
                      {!overview.data ? (
                        <Skeleton className="h-3 w-32" />
                      ) : st?.last ? (
                        <>
                          <span className="flex items-center gap-2">
                            <i
                              className={cn('size-2 flex-none rounded-full', OUTCOME_DOT[st.last.tone])}
                              aria-hidden="true"
                            />
                            <span className="truncate text-text-2">{when(st.last.t)}</span>
                          </span>
                          <span className="mt-0.5 block truncate pl-4 text-text-3">{st.last.nodeName}</span>
                        </>
                      ) : (
                        <span className="text-text-3">
                          {rule.enabled ? 'ещё не срабатывал' : 'выключен — не срабатывает'}
                        </span>
                      )}
                    </span>
                    <span className="flex flex-col gap-1.5 max-xl:hidden">
                      {overview.data && st && (
                        <>
                          <RunStrip strip={st.strip} size="sm" timeZone={overview.data.timeZone} />
                          <span className="text-[12px] text-text-3">
                            {st.day ? (
                              <>
                                <b className="font-semibold text-text-2">{st.day}</b> за сутки
                                {st.dayWarn > 0 && (
                                  <span className="text-warn"> · {st.dayWarn} с замечанием</span>
                                )}
                              </>
                            ) : (
                              'за сутки — 0'
                            )}
                          </span>
                        </>
                      )}
                    </span>
                    <ChevronRightIcon className="size-4 text-text-3" aria-hidden="true" />
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {error && !editing && (
        <p role="alert" className="text-[13px] text-crit">
          {error}
        </p>
      )}
      {editing && (
        <ScenarioEditor
          draft={editing.draft}
          original={editing.original}
          initialTab={editing.tab}
          {...(editing.node ? { runsNode: editing.node } : {})}
          summary={stats.get(editing.draft.id) ?? null}
          {...(overview.data ? { timeZone: overview.data.timeZone } : {})}
          setDraft={(next) =>
            setEditing((cur) =>
              cur
                ? {
                    ...cur,
                    draft: typeof next === 'function' ? (next(cur.draft) ?? cur.draft) : (next ?? cur.draft),
                  }
                : cur,
            )
          }
          busy={save.isPending}
          onClose={() => {
            setEditing(null);
            setError(null);
          }}
          // Правленый сценарий остаётся на своём месте в списке, новый — в конце.
          onSave={() =>
            void persist(
              items.some((r) => r.id === editing.draft.id)
                ? items.map((r) => (r.id === editing.draft.id ? editing.draft : r))
                : [...items, editing.draft],
            )
          }
          // «Включён» в окне сохраняется сразу — отдельно от остальных правок.
          onToggleEnabled={
            editing.original
              ? async (enabled) => {
                  const ok = await persist(
                    items.map((r) => (r.id === editing.draft.id ? { ...r, enabled } : r)),
                    false,
                  );
                  if (ok)
                    setEditing((cur) =>
                      cur?.original
                        ? { ...cur, draft: { ...cur.draft, enabled }, original: { ...cur.original, enabled } }
                        : cur,
                    );
                }
              : undefined
          }
          onDuplicate={
            editing.original
              ? () =>
                  setEditing({
                    draft: {
                      ...editing.draft,
                      id: randomId(),
                      name: `${editing.draft.name} (копия)`,
                      enabled: false,
                    },
                    original: null,
                    tab: 'rule',
                  })
              : undefined
          }
          onDelete={
            items.some((r) => r.id === editing.draft.id)
              ? () => void persist(items.filter((r) => r.id !== editing.draft.id))
              : undefined
          }
          rules={items}
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
