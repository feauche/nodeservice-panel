import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';

import { AppShell } from '@/components/layout/app-shell';
import { requireAuth } from '@/features/auth/guards';
import { IncidentsPage } from '@/features/incidents/incidents-page';
import { requireSectionOpen } from '@/lib/stages';

/** Раскрытый инцидент (?open=<id>) — ссылка из уведомления или Журнала. */
const incidentsSearchSchema = z.object({ open: z.uuid().optional().catch(undefined) });

export const Route = createFileRoute('/incidents')({
  validateSearch: (raw: Record<string, unknown>) => incidentsSearchSchema.parse(raw),
  beforeLoad: async ({ context }) => {
    await requireAuth(context);
    requireSectionOpen('/incidents');
  },
  component: IncidentsRoute,
});

function IncidentsRoute() {
  const { open } = Route.useSearch();
  return (
    <AppShell title="Инциденты" subtitle="Где, что и чем чинили — вся история проблем парка">
      <IncidentsPage openId={open} />
    </AppShell>
  );
}
