import { createFileRoute, redirect, useNavigate } from '@tanstack/react-router';

import { AppShell } from '@/components/layout/app-shell';
import { requireAuth } from '@/features/auth/guards';
import { OverviewCapacity } from '@/features/overview/overview-capacity';
import { OverviewNow } from '@/features/overview/overview-now';
import { OverviewStats } from '@/features/overview/overview-stats';
import { Segmented } from '@/features/settings/settings-ui';
import { requireSectionOpen } from '@/lib/stages';

type OverviewView = 'now' | 'stats' | 'capacity';

export const Route = createFileRoute('/')({
  validateSearch: (
    raw: Record<string, unknown>,
  ): { view?: 'stats' | 'capacity' | 'metrics'; detail?: 'metrics' } =>
    raw.view === 'metrics'
      ? { view: 'metrics' }
      : raw.view === 'stats'
        ? { view: 'stats', ...(raw.detail === 'metrics' ? { detail: 'metrics' as const } : {}) }
        : raw.view === 'capacity'
          ? { view: 'capacity' }
          : {},
  beforeLoad: async ({ context, search }) => {
    await requireAuth(context);
    requireSectionOpen('/');
    if (search.view === 'metrics' || search.detail === 'metrics') throw redirect({ to: '/metrics' });
  },
  component: Overview,
});

/**
 * «Обзор»: вкладки «Сейчас / Статистика / Ёмкость» в шапке. Раскладка — витрина redesign-2026-10: «Сейчас»
 * в стиле 0.67.0, «Статистика» — отчёт за период, «Ёмкость» — запас по нодам.
 */
function Overview() {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: '/' });
  const view: OverviewView = search.view === 'metrics' ? 'stats' : (search.view ?? 'now');
  return (
    <AppShell
      title="Обзор"
      subtitle={
        view === 'stats'
          ? 'Что было за период: трафик, онлайн, часы пика, сбои и ноды'
          : view === 'capacity'
            ? 'Сколько ещё пользователей выдержит каждая нода'
            : 'Состояние нод одним взглядом'
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
      {view === 'stats' ? <OverviewStats /> : view === 'capacity' ? <OverviewCapacity /> : <OverviewNow />}
    </AppShell>
  );
}
