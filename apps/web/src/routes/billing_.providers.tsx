import { createFileRoute, Link } from '@tanstack/react-router';

import { AppShell } from '@/components/layout/app-shell';
import { requireAuth } from '@/features/auth/guards';
import { ProvidersSourceContext } from '@/features/providers/providers-api';
import { ProvidersPage } from '@/features/providers/providers-page';
import { requireSectionOpen } from '@/lib/stages';

/** /billing/providers — справочник хостеров — отдельная страница внутри биллинга. */
export const Route = createFileRoute('/billing_/providers')({
  beforeLoad: async ({ context }) => {
    await requireAuth(context);
    requireSectionOpen('/billing/providers');
  },
  component: ProvidersRoute,
});

function ProvidersRoute() {
  return (
    <AppShell title="Провайдеры" subtitle="Провайдеры из биллинга Remnawave: название, сайт и ноды">
      <div className="mb-4">
        <Link to="/billing" className="text-[13px] text-text-2 hover:text-brand">
          ← Биллинг
        </Link>
      </div>
      <ProvidersSourceContext.Provider value="/nodes/providers/catalog">
        <ProvidersPage />
      </ProvidersSourceContext.Provider>
    </AppShell>
  );
}
