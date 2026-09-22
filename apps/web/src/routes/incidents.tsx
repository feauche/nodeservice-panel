import { createFileRoute } from '@tanstack/react-router';

import { AppShell } from '@/components/layout/app-shell';
import { requireAuth } from '@/features/auth/guards';
import { IncidentsPage } from '@/features/incidents/incidents-page';
import { requireSectionOpen } from '@/lib/stages';

export const Route = createFileRoute('/incidents')({
  beforeLoad: async ({ context }) => {
    await requireAuth(context);
    requireSectionOpen('/incidents');
  },
  component: IncidentsRoute,
});

function IncidentsRoute() {
  return (
    <AppShell title="Инциденты" subtitle="Где, что и чем чинили — вся история проблем парка">
      <IncidentsPage />
    </AppShell>
  );
}
