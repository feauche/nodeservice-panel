import { createFileRoute } from '@tanstack/react-router';

import { requireAuth } from '@/features/auth/guards';
import { BackupsPage } from '@/features/backups/backups-page';
import { requireSectionOpen } from '@/lib/stages';

export const Route = createFileRoute('/settings/backups')({
  beforeLoad: async ({ context }) => {
    await requireAuth(context);
    requireSectionOpen('/settings/backups');
  },
  component: BackupsPage,
});
