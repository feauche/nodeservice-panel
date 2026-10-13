import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';
import { AppShell } from '@/components/layout/app-shell';
import { requireAuth } from '@/features/auth/guards';
import { IntegrationsPage } from '@/features/integrations/integrations-page';

/** ?node=<uuid> — из совета Ассистента: открыть проверку сразу с этой нодой. */
const searchSchema = z.object({ node: z.string().max(64).optional().catch(undefined) });
export const Route = createFileRoute('/integrations_/bschecker')({
  beforeLoad: ({ context }) => requireAuth(context),
  validateSearch: (raw: Record<string, unknown>) => searchSchema.parse(raw),
  component: Page,
});

function Page() {
  const { node } = Route.useSearch();
  const navigate = Route.useNavigate();
  return (
    <AppShell title="BS Checker" subtitle="Проходит ли нода белые списки мобильных операторов">
      <IntegrationsPage
        kind="bschecker"
        initialNode={node}
        onInitialNodeUsed={() => void navigate({ search: {}, replace: true })}
      />
    </AppShell>
  );
}
