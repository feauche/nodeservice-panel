import { createFileRoute } from '@tanstack/react-router';

import { requireAuth } from '@/features/auth/guards';
import { AppearancePage } from '@/features/settings/appearance-page';
import { requireSectionOpen } from '@/lib/stages';

export const Route = createFileRoute('/settings/appearance')({
  beforeLoad: async ({ context }) => {
    await requireAuth(context);
    requireSectionOpen('/settings/appearance');
  },
  component: AppearancePage,
});
