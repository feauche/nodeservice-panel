import { createFileRoute } from '@tanstack/react-router';

import { requireAuth } from '@/features/auth/guards';
import { IncidentsSettingsPage } from '@/features/incidents/incidents-settings-page';

export const Route = createFileRoute('/settings/incidents')({
  beforeLoad: ({ context }) => requireAuth(context),
  component: IncidentsSettingsPage,
});
