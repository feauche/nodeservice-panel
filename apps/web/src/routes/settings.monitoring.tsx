import { createFileRoute } from '@tanstack/react-router';

import { requireAuth } from '@/features/auth/guards';
import { NodeMonitoringPage } from '@/features/settings/node-monitoring-page';
import { requireSectionOpen } from '@/lib/stages';

export const Route = createFileRoute('/settings/monitoring')({
  beforeLoad: async ({ context }) => {
    await requireAuth(context);
    requireSectionOpen('/settings/monitoring');
  },
  component: NodeMonitoringPage,
});
