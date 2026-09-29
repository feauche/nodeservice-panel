import { createFileRoute, useNavigate } from '@tanstack/react-router';

import { AppShell } from '@/components/layout/app-shell';
import { requireAuth } from '@/features/auth/guards';
import { FleetStatsView } from '@/features/overview/fleet-stats-view';
import { OverviewPage } from '@/features/overview/overview-page';
import { Segmented } from '@/features/settings/settings-ui';
import { requireSectionOpen } from '@/lib/stages';

type OverviewView = 'now' | 'stats';

export const Route = createFileRoute('/')({
  validateSearch: (raw: Record<string, unknown>): { view?: 'stats' } =>
    raw.view === 'stats' ? { view: 'stats' } : {},
  beforeLoad: async ({ context }) => {
    await requireAuth(context);
    requireSectionOpen('/');
  },
  component: Overview,
});

/** «Обзор»: вкладки «Сейчас / Статистика» в шапке (витрина `stats-switch-variants.html`, вариант 1). */
function Overview() {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: '/' });
  const view: OverviewView = search.view ?? 'now';
  return (
    <AppShell
      title="Обзор"
      subtitle={
        view === 'stats'
          ? 'Трафик, нагрузка, доступность и деньги по всему парку за период'
          : 'Состояние парка серверов одним взглядом'
      }
      aside={
        <Segmented
          label="Раздел обзора"
          value={view}
          onChange={(v: OverviewView) => void navigate({ search: v === 'stats' ? { view: 'stats' } : {} })}
          items={[
            { key: 'now', label: 'Сейчас' },
            { key: 'stats', label: 'Статистика' },
          ]}
        />
      }
    >
      {view === 'stats' ? <FleetStatsView /> : <OverviewPage />}
    </AppShell>
  );
}
