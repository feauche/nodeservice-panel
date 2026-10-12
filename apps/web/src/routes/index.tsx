import { createFileRoute, redirect, useNavigate } from '@tanstack/react-router';

import { AppShell } from '@/components/layout/app-shell';
import { requireAuth } from '@/features/auth/guards';
import { RemnaOverview } from '@/features/overview/remna-overview';
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
 * «Обзор»: вкладки «Сейчас / Статистика / Ёмкость» в шапке (витрины `stats-switch-variants.html`, вариант 1, и
 * `capacity-0.58-readings-variants.html`, вариант A).
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
      <RemnaOverview view={view} />
    </AppShell>
  );
}
