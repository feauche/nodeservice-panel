import { createFileRoute } from '@tanstack/react-router';

import { AppShell } from '@/components/layout/app-shell';
import { requireAuth } from '@/features/auth/guards';
import { RemnawavePage } from '@/features/remnawave/remnawave-page';
import { requireSectionOpen } from '@/lib/stages';

/** /servers/remnawave — подключение к панели Remnawave, только чтение (J4, подпункт «Серверы»). */
export const Route = createFileRoute('/servers_/remnawave')({
  beforeLoad: async ({ context }) => {
    await requireAuth(context);
    requireSectionOpen('/servers/remnawave');
  },
  component: RemnawaveRoute,
});

function RemnawaveRoute() {
  return (
    <AppShell
      title="Remnawave"
      subtitle="Панель, которая управляет нодами Xray: подключение только для чтения"
    >
      <RemnawavePage />
    </AppShell>
  );
}
