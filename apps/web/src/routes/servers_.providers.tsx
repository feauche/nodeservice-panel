import { createFileRoute } from '@tanstack/react-router';

import { AppShell } from '@/components/layout/app-shell';
import { requireAuth } from '@/features/auth/guards';
import { ProvidersPage } from '@/features/providers/providers-page';
import { requireSectionOpen } from '@/lib/stages';

/** /servers/providers — справочник хостеров (подпункт «Серверы» в меню). */
export const Route = createFileRoute('/servers_/providers')({
  beforeLoad: async ({ context }) => {
    await requireAuth(context);
    requireSectionOpen('/servers/providers');
  },
  component: ProvidersRoute,
});

function ProvidersRoute() {
  return (
    <AppShell title="Провайдеры" subtitle="Хостеры, у которых куплены серверы: название, сайт и иконка">
      <ProvidersPage />
    </AppShell>
  );
}
