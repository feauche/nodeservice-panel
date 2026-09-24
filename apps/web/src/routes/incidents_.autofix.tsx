import { createFileRoute } from '@tanstack/react-router';

import { AppShell } from '@/components/layout/app-shell';
import { requireAuth } from '@/features/auth/guards';
import { AutofixPage } from '@/features/incidents/autofix-page';
import { requireSectionOpen } from '@/lib/stages';

/** /incidents/autofix — политика автопочинки по сигналам (витрина v3, C1). */
export const Route = createFileRoute('/incidents_/autofix')({
  beforeLoad: async ({ context }) => {
    await requireAuth(context);
    requireSectionOpen('/incidents/autofix');
  },
  component: AutofixRoute,
});

function AutofixRoute() {
  return (
    <AppShell title="Автопочинка" subtitle="Что панель чинит сама, о чём спрашивает, за чем только наблюдает">
      <AutofixPage />
    </AppShell>
  );
}
