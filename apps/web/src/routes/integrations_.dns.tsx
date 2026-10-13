import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';
import { AppShell } from '@/components/layout/app-shell';
import { requireAuth } from '@/features/auth/guards';
import { IntegrationsPage } from '@/features/integrations/integrations-page';

/** ?record=<id> — из события ноды: сразу открыть окно этой DNS-записи. */
const searchSchema = z.object({ record: z.string().max(500).optional().catch(undefined) });
export const Route = createFileRoute('/integrations_/dns')({
  beforeLoad: ({ context }) => requireAuth(context),
  validateSearch: (raw: Record<string, unknown>) => searchSchema.parse(raw),
  component: Page,
});

function Page() {
  const { record } = Route.useSearch();
  const navigate = Route.useNavigate();
  return (
    <AppShell title="DNS интеграции" subtitle="Cloudflare и REG.RU — записи доменов и их связь с нодами">
      <IntegrationsPage
        kind="dns"
        initialRecord={record}
        onInitialNodeUsed={() => void navigate({ search: {}, replace: true })}
      />
    </AppShell>
  );
}
