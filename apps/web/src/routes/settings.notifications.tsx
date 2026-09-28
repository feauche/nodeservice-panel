import { createFileRoute } from '@tanstack/react-router';

import { requireAuth } from '@/features/auth/guards';
import { NotificationsPage } from '@/features/settings/notifications-page';
import { requireSectionOpen } from '@/lib/stages';

export const Route = createFileRoute('/settings/notifications')({
  beforeLoad: async ({ context }) => {
    await requireAuth(context);
    requireSectionOpen('/settings/notifications');
  },
  component: NotificationsPage,
});
