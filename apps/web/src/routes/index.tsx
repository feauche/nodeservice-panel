import { createFileRoute, useNavigate } from '@tanstack/react-router';

import { AppShell } from '@/components/layout/app-shell';
import { requireAuth } from '@/features/auth/guards';
import { CapacityView } from '@/features/overview/capacity-view';
import { FleetStatsView } from '@/features/overview/fleet-stats-view';
import { OverviewPage } from '@/features/overview/overview-page';
import { Segmented } from '@/features/settings/settings-ui';
import { requireSectionOpen } from '@/lib/stages';

type OverviewView = 'now' | 'stats' | 'capacity';

export const Route = createFileRoute('/')({
  validateSearch: (raw: Record<string, unknown>): { view?: 'stats' | 'capacity' } =>
    raw.view === 'stats' || raw.view === 'capacity' ? { view: raw.view } : {},
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
          ? 'Трафик, нагрузка, доступность и деньги по всему парку за период'
          : view === 'capacity'
            ? 'Сколько ещё людей выдержат ноды и во что упрёмся первым'
            : 'Состояние парка серверов одним взглядом'
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
      {view === 'stats' ? <FleetStatsView /> : view === 'capacity' ? <CapacityView /> : <OverviewPage />}
    </AppShell>
  );
}
