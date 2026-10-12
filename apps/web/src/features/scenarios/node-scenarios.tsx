import { scenarioActionLabels, scenarioConditionLabel } from '@nodeservice/shared';
import { RowsSkeleton } from '@/components/ui/loading-state';
import { Pill } from '@/features/settings/settings-ui';
import { apiErrorMessage } from '@/lib/api';
import { useScenarios } from './scenarios-api';

export function NodeScenarios({ uuid }: { uuid: string }) {
  const q = useScenarios();
  if (q.isPending) return <RowsSkeleton rows={2} label="Загрузка сценариев ноды" />;
  if (q.isError)
    return (
      <p role="alert" className="text-sm text-crit">
        {apiErrorMessage(q.error)}
      </p>
    );
  const items = q.data?.items.filter((r) => r.scope === 'all' || r.nodes.includes(uuid)) ?? [];
  return (
    <section className="space-y-3">
      <h3 className="text-sm font-semibold">Сценарии ноды</h3>
      {!items.length ? (
        <p className="text-xs text-text-3">Общие и индивидуальные сценарии ещё не назначены.</p>
      ) : (
        items.map((r) => (
          <a
            key={r.id}
            href="/scenarios"
            className="block rounded-xl border border-border bg-surface p-3 hover:bg-surface-2"
          >
            <div className="flex items-center justify-between gap-3">
              <strong className="text-sm">{r.name}</strong>
              <Pill tone={r.enabled ? 'ok' : 'muted'}>{r.enabled ? 'Включён' : 'Выключен'}</Pill>
            </div>
            <p className="mt-2 text-xs text-text-3">
              {r.scope === 'selected' ? 'Индивидуальный' : 'Общий'} · {scenarioConditionLabel(r)} ·{' '}
              {r.holdMinutes} мин
            </p>
            <p className="mt-1 text-xs text-text-2">
              {r.actions.map((a) => scenarioActionLabels[a]).join(' → ')}
            </p>
          </a>
        ))
      )}
    </section>
  );
}
