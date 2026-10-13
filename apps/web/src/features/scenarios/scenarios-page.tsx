import { type Scenario, scenarioActionLabels, scenarioConditionLabel } from '@nodeservice/shared';
import { ArrowRightIcon, GitBranchIcon, GlobeIcon, PlusIcon, Settings2Icon } from 'lucide-react';
import { useState } from 'react';
import { Skeleton } from '@/components/ui/skeleton';
import { useNodes } from '@/features/nodes/nodes-api';
import { BarButton, CardButton, Pill } from '@/features/settings/settings-ui';
import { apiErrorMessage } from '@/lib/api';
import { ScenarioEditor } from './scenario-editor';
import { useSaveScenarios, useScenarios } from './scenarios-api';

const make = (): Scenario => ({
  id: crypto.randomUUID(),
  name: 'Новый сценарий',
  enabled: false,
  scope: 'all',
  nodes: [],
  trigger: 'offline',
  holdMinutes: 5,
  conditions: [],
  conditionMode: 'all' as const,
  actions: ['check_tcp', 'record_event'],
  renameMode: 'append',
  renameText: '',
  hostBindings: [],
  autoRestore: false,
  cooldownMinutes: 30,
});
/** Скелетон списка — те же карточки: шапка с пилюлей, условие, цепочка шагов, подвал с двумя кнопками. */
function ScenarioCardsSkeleton() {
  return (
    <div role="status" aria-label="Загрузка сценариев" className="grid gap-4 xl:grid-cols-2">
      {[1, 2].map((i) => (
        <section key={i} className="overflow-hidden rounded-[14px] border border-border bg-surface">
          <header className="flex items-center justify-between gap-3 border-b border-border p-4">
            <div className="flex-1 space-y-2">
              <Skeleton className="h-4 w-2/5" />
              <Skeleton className="h-3 w-1/4" />
            </div>
            <Skeleton className="h-6 w-20 rounded-full" />
          </header>
          <div className="space-y-4 p-4">
            <div className="space-y-2 rounded-xl border border-border bg-surface-2 p-3">
              <Skeleton className="h-4 w-1/2" />
              <Skeleton className="h-3 w-2/3" />
            </div>
            <div className="flex gap-2">
              <Skeleton className="h-7 w-28 rounded-lg" />
              <Skeleton className="h-7 w-32 rounded-lg" />
              <Skeleton className="h-7 w-24 rounded-lg" />
            </div>
          </div>
          <footer className="flex items-center justify-between border-t border-border bg-bg-2 p-4">
            <Skeleton className="h-[34px] w-32 rounded-[9px]" />
            <Skeleton className="h-[34px] w-32 rounded-[9px]" />
          </footer>
        </section>
      ))}
    </div>
  );
}
export function ScenariosPage() {
  const q = useScenarios(),
    save = useSaveScenarios(),
    nodes = useNodes();
  const [draft, setDraft] = useState<Scenario | null>(null),
    [error, setError] = useState<string | null>(null);
  const items = q.data?.items ?? [];
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
    <div className="space-y-4">
      <section className="flex flex-wrap items-center justify-between gap-4 rounded-[14px] border border-border bg-surface p-5">
        <div className="flex items-center gap-3">
          <span className="grid size-10 place-items-center rounded-xl bg-brand-soft text-brand">
            <GitBranchIcon className="size-5" />
          </span>
          <div>
            <h2 className="font-heading text-base font-semibold">Сценарии нод</h2>
            <p className="mt-1 text-xs text-text-3">
              Условие → проверка → действие. Общие правила и выбранные ноды.
            </p>
          </div>
        </div>
        <CardButton className="h-10" onClick={() => setDraft(make())} disabled={!nodes.data?.connected}>
          <PlusIcon />
          Создать сценарий
        </CardButton>
      </section>
      {q.isPending ? (
        <ScenarioCardsSkeleton />
      ) : q.isError ? (
        <p role="alert" className="text-crit">
          {apiErrorMessage(q.error)}
        </p>
      ) : !items.length ? (
        <section className="grid min-h-52 place-content-center rounded-[14px] border border-dashed border-border p-6 text-center">
          <GitBranchIcon className="mx-auto mb-3 size-7 text-brand" />
          <h3 className="font-medium">Сценарии ещё не созданы</h3>
          <p className="mt-2 text-sm text-text-3">
            Начните с проверки TCP и записи события. Новые сценарии выключены.
          </p>
        </section>
      ) : (
        <div className="grid gap-4 xl:grid-cols-2">
          {items.map((rule) => (
            <section key={rule.id} className="overflow-hidden rounded-[14px] border border-border bg-surface">
              <header className="flex items-center justify-between gap-3 border-b border-border p-4">
                <div>
                  <h3 className="font-medium">{rule.name}</h3>
                  <p className="mt-1 flex items-center gap-1 text-xs text-text-3">
                    <GlobeIcon className="size-3" />
                    {rule.scope === 'selected' ? `Выбрано нод: ${rule.nodes.length}` : 'Все ноды'}
                  </p>
                </div>
                <Pill tone={rule.enabled ? 'ok' : 'muted'}>{rule.enabled ? 'Включён' : 'Выключен'}</Pill>
              </header>
              <div className="space-y-4 p-4">
                <div className="rounded-xl border border-border bg-surface-2 p-3 text-sm">
                  {scenarioConditionLabel(rule)}
                  <span className="mt-1 block text-xs text-text-3">
                    Подтверждение в течение {rule.holdMinutes} мин · повтор не ранее {rule.cooldownMinutes}{' '}
                    мин
                  </span>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  {rule.actions.map((a, i) => (
                    <div key={a} className="contents">
                      {i > 0 && <ArrowRightIcon className="size-3 text-text-3" />}
                      <span className="rounded-lg border border-border px-2 py-1.5 text-xs">
                        {scenarioActionLabels[a]}
                      </span>
                    </div>
                  ))}
                </div>
                {rule.actions.includes('hide_host') && (
                  <p className="text-xs text-text-3">
                    Восстановление Host:{' '}
                    {rule.autoRestore ? 'автоматически после восстановления ноды' : 'вручную в Remnawave'}
                  </p>
                )}
              </div>
              <footer className="flex items-center justify-between border-t border-border bg-bg-2 p-4">
                <BarButton
                  onClick={() =>
                    void persist(items.map((r) => (r.id === rule.id ? { ...r, enabled: !r.enabled } : r)))
                  }
                  disabled={save.isPending}
                >
                  {rule.enabled ? 'Выключить' : 'Включить'}
                </BarButton>
                <BarButton onClick={() => setDraft(rule)}>
                  <Settings2Icon />
                  Настроить
                </BarButton>
              </footer>
            </section>
          ))}
        </div>
      )}
      {error && (
        <p role="alert" className="text-sm text-crit">
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
