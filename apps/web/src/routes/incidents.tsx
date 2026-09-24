import { createFileRoute, redirect } from '@tanstack/react-router';
import { z } from 'zod';

import { AppShell } from '@/components/layout/app-shell';
import { requireAuth } from '@/features/auth/guards';
import { IncidentsPage } from '@/features/incidents/incidents-page';
import { requireSectionOpen } from '@/lib/stages';

/** Старые ссылки вида ?open=<id> (уведомления, Журнал) ведут на страницу-кейс. */
const incidentsSearchSchema = z.object({ open: z.uuid().optional().catch(undefined) });

export const Route = createFileRoute('/incidents')({
  validateSearch: (raw: Record<string, unknown>) => incidentsSearchSchema.parse(raw),
  beforeLoad: async ({ context, search }) => {
    await requireAuth(context);
    requireSectionOpen('/incidents');
    if (search.open) throw redirect({ to: '/incidents/$id', params: { id: search.open } });
  },
  component: IncidentsRoute,
});

function IncidentsRoute() {
  return (
    <AppShell title="Инциденты" subtitle="История сбоев парка и чем их чинили">
      <IncidentsPage />
    </AppShell>
  );
}
