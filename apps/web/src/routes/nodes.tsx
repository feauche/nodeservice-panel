import { createFileRoute } from '@tanstack/react-router';
import { AppShell } from '@/components/layout/app-shell';
import { requireAuth } from '@/features/auth/guards';
import { NodesPage } from '@/features/nodes/nodes-page';
export const Route = createFileRoute('/nodes')({
  beforeLoad: ({ context }) => requireAuth(context),
  component: () => (
    <AppShell title="Ноды" subtitle="Состояние сети и онлайн по данным Remnawave">
      <NodesPage />
    </AppShell>
  ),
});
