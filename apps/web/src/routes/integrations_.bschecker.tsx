import { createFileRoute } from '@tanstack/react-router';
import { AppShell } from '@/components/layout/app-shell';
import { requireAuth } from '@/features/auth/guards';
import { IntegrationsPage } from '@/features/integrations/integrations-page';
export const Route = createFileRoute('/integrations_/bschecker')({
  beforeLoad: ({ context }) => requireAuth(context),
  component: () => (
    <AppShell title="BS Checker" subtitle="Ручная проверка доступности IP у операторов">
      <IntegrationsPage kind="bschecker" />
    </AppShell>
  ),
});
