import { createFileRoute } from '@tanstack/react-router';

import { requireAuth } from '@/features/auth/guards';
import { SecurityPage } from '@/features/security/security-page';

export const Route = createFileRoute('/settings/security')({
  beforeLoad: ({ context }) => requireAuth(context),
  component: SecurityPage,
});
