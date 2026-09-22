import { createFileRoute, redirect } from '@tanstack/react-router';

import { requireAuth } from '@/features/auth/guards';

export const Route = createFileRoute('/settings/')({
  beforeLoad: async ({ context }) => {
    await requireAuth(context);
    throw redirect({ to: '/settings/appearance', replace: true });
  },
});
