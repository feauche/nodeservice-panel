import { createFileRoute } from '@tanstack/react-router';
import { AppShell } from '@/components/layout/app-shell';
import { requireAuth } from '@/features/auth/guards';
import { MetricsHistoryPage } from '@/features/metrics/metrics-history-page';
export const Route = createFileRoute('/metrics')({
  beforeLoad: ({ context }) => requireAuth(context),
  component: () => (
    <AppShell title="История метрик" subtitle="Ноды, инциденты и TCP-проверки на одной временной шкале">
      <MetricsHistoryPage />
    </AppShell>
  ),
});
