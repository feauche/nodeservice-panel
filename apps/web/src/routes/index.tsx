import { createFileRoute } from '@tanstack/react-router';

import { AppShell } from '@/components/layout/app-shell';
import { requireAuth } from '@/features/auth/guards';
import { OverviewPage } from '@/features/overview/overview-page';
import { requireSectionOpen } from '@/lib/stages';

export const Route = createFileRoute('/')({
  beforeLoad: async ({ context }) => {
    await requireAuth(context);
    requireSectionOpen('/');
  },
  component: Overview,
});

function Overview() {
  return (
    <AppShell title="Обзор" subtitle="Состояние парка серверов одним взглядом">
      <OverviewPage />
    </AppShell>
  );
}
