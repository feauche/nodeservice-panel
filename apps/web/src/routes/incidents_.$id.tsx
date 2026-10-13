import { createFileRoute } from '@tanstack/react-router';

import { AppShell } from '@/components/layout/app-shell';
import { requireAuth } from '@/features/auth/guards';
import { IncidentCasePage } from '@/features/incidents/incident-case-page';
import { requireSectionOpen } from '@/lib/stages';

/** /incidents/<id> — событие как страница-кейс (витрина v3, B1). */
export const Route = createFileRoute('/incidents_/$id')({
  beforeLoad: async ({ context }) => {
    await requireAuth(context);
    requireSectionOpen('/incidents');
  },
  component: IncidentCaseRoute,
});

function IncidentCaseRoute() {
  const { id } = Route.useParams();
  return (
    <AppShell title="Событие" subtitle="Что случилось, шаги восстановления и хронология">
      <IncidentCasePage id={id} />
    </AppShell>
  );
}
