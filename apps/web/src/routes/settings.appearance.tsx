import { createFileRoute } from '@tanstack/react-router';

import { requireAuth } from '@/features/auth/guards';
import { AppearancePage } from '@/features/settings/appearance-page';

export const Route = createFileRoute('/settings/appearance')({
  beforeLoad: ({ context }) => requireAuth(context),
  component: AppearancePage,
});
