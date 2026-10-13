import { createFileRoute } from '@tanstack/react-router';
import { AppShell } from '@/components/layout/app-shell';
import { requireAuth } from '@/features/auth/guards';
import { IntegrationsPage } from '@/features/integrations/integrations-page';
export const Route = createFileRoute('/integrations_/dns')({
  beforeLoad: ({ context }) => requireAuth(context),
  component: () => (
    <AppShell title="DNS интеграции" subtitle="Cloudflare и REG.RU — записи доменов и их связь с нодами">
      <IntegrationsPage kind="dns" />
    </AppShell>
  ),
});
