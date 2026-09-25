import { createFileRoute } from '@tanstack/react-router';

import { requireAuth } from '@/features/auth/guards';
import { SecurityPage } from '@/features/security/security-page';
import { requireSectionOpen } from '@/lib/stages';

export const Route = createFileRoute('/settings/security')({
  beforeLoad: async ({ context }) => {
    await requireAuth(context);
    requireSectionOpen('/settings/security');
  },
  component: SecurityPage,
});
