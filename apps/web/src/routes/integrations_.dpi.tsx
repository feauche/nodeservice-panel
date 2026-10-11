import { createFileRoute } from '@tanstack/react-router';
import { AppShell } from '@/components/layout/app-shell';
import { requireAuth } from '@/features/auth/guards';
import { IntegrationsPage } from '@/features/integrations/integrations-page';
export const Route = createFileRoute('/integrations_/dpi')({
  beforeLoad: ({ context }) => requireAuth(context),
  component: () => (
    <AppShell title="DPI Checker" subtitle="Подключение сервиса проверки доступности">
      <IntegrationsPage kind="dpi" />
    </AppShell>
  ),
});
