import { createFileRoute } from '@tanstack/react-router';

import { requireAuth } from '@/features/auth/guards';
import { IncidentsSettingsPage } from '@/features/incidents/incidents-settings-page';
import { requireSectionOpen } from '@/lib/stages';

export const Route = createFileRoute('/settings/incidents')({
  beforeLoad: async ({ context }) => {
    await requireAuth(context);
    requireSectionOpen('/settings/incidents');
  },
  component: IncidentsSettingsPage,
});
