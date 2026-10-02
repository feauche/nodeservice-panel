import { createFileRoute } from '@tanstack/react-router';

import { AppShell } from '@/components/layout/app-shell';
import { requireAuth } from '@/features/auth/guards';
import { NotificationsCenterPage } from '@/features/notifications/notifications-center-page';
import { requireSectionOpen } from '@/lib/stages';

export const Route = createFileRoute('/notifications')({
  beforeLoad: async ({ context }) => {
    await requireAuth(context);
    requireSectionOpen('/notifications');
  },
  component: NotificationsRoute,
});

function NotificationsRoute() {
  return (
    <AppShell title="Уведомления" subtitle="Отчёты автопроверок, обслуживания и важных событий парка">
      <NotificationsCenterPage />
    </AppShell>
  );
}
