import { createFileRoute } from '@tanstack/react-router';
import { AppShell } from '@/components/layout/app-shell';
import { requireAuth } from '@/features/auth/guards';
import { MetricsHistoryPage } from '@/features/metrics/metrics-history-page';
export const Route = createFileRoute('/metrics')({
  beforeLoad: async ({ context }) => {
    await requireAuth(context);
  },
  component: () => (
    <AppShell title="Метрики" subtitle="История нод, проверки и события на одной временной шкале">
      <MetricsHistoryPage />
    </AppShell>
  ),
});
