import { createFileRoute, useNavigate } from '@tanstack/react-router';

import { AppShell } from '@/components/layout/app-shell';
import { requireAuth } from '@/features/auth/guards';
import { MetricsHistoryPage } from '@/features/metrics/metrics-history-page';
import { RemnaOverview } from '@/features/overview/remna-overview';
import { Segmented } from '@/features/settings/settings-ui';
import { requireSectionOpen } from '@/lib/stages';

type OverviewView = 'now' | 'stats' | 'capacity';

export const Route = createFileRoute('/')({
  validateSearch: (raw: Record<string, unknown>): { view?: 'stats' | 'capacity'; detail?: 'metrics' } =>
    raw.view === 'stats'
      ? { view: 'stats', ...(raw.detail === 'metrics' ? { detail: 'metrics' as const } : {}) }
      : raw.view === 'capacity'
        ? { view: 'capacity' }
        : {},
  beforeLoad: async ({ context }) => {
    await requireAuth(context);
    requireSectionOpen('/');
  },
  component: Overview,
});

/**
 * «Обзор»: вкладки «Сейчас / Статистика / Ёмкость» в шапке (витрины `stats-switch-variants.html`, вариант 1, и
 * `capacity-0.58-readings-variants.html`, вариант A).
 */
function Overview() {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: '/' });
  const view: OverviewView = search.view ?? 'now';
  return (
    <AppShell
      title="Обзор"
      subtitle={
        view === 'stats'
          ? search.detail === 'metrics'
            ? 'Подробный разбор нод, метрик и событий за выбранный промежуток'
            : 'Трафик, нагрузка, доступность и деньги по всему парку за период'
          : view === 'capacity'
            ? 'Ресурсы, нагрузка и доступные лимиты нод'
            : 'Состояние нод и метрики Remnawave'
      }
      aside={
        <Segmented
          label="Раздел обзора"
          value={view}
          onChange={(v: OverviewView) => void navigate({ search: v === 'now' ? {} : { view: v } })}
          items={[
            { key: 'now', label: 'Сейчас' },
            { key: 'stats', label: 'Статистика' },
            { key: 'capacity', label: 'Ёмкость' },
          ]}
        />
      }
    >
      {view === 'stats' && search.detail === 'metrics' ? (
        <MetricsHistoryPage overview />
      ) : (
        <RemnaOverview view={view} />
      )}
    </AppShell>
  );
}
