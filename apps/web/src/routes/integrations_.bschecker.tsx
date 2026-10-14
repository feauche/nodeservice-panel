import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';
import { AppShell } from '@/components/layout/app-shell';
import { requireAuth } from '@/features/auth/guards';
import { IntegrationsPage } from '@/features/integrations/integrations-page';

/**
 * ?node=<uuid> — из совета Ассистента или события: открыть проверку сразу с этой нодой; &port= и &sni= — порт и имя
 * SNI её подключения (проверка откроется заполненной).
 */
const searchSchema = z.object({
  node: z.string().max(64).optional().catch(undefined),
  port: z.coerce.number().int().min(1).max(65535).optional().catch(undefined),
  sni: z.string().trim().min(3).max(253).optional().catch(undefined),
});
export const Route = createFileRoute('/integrations_/bschecker')({
  beforeLoad: ({ context }) => requireAuth(context),
  validateSearch: (raw: Record<string, unknown>) => searchSchema.parse(raw),
  component: Page,
});

function Page() {
  const { node, port, sni } = Route.useSearch();
  const navigate = Route.useNavigate();
  return (
    <AppShell title="BS Checker" subtitle="Проходит ли нода белые списки мобильных операторов">
      <IntegrationsPage
        kind="bschecker"
        initialNode={node}
        initialPort={port}
        initialSni={sni}
        onInitialNodeUsed={() => void navigate({ search: {}, replace: true })}
      />
    </AppShell>
  );
}
