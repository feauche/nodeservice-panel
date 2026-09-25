import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';

import { AppShell } from '@/components/layout/app-shell';
import { requireAuth } from '@/features/auth/guards';
import { KnowledgePage } from '@/features/knowledge/knowledge-page';
import { requireSectionOpen } from '@/lib/stages';

const knowledgeSearchSchema = z.object({
  /** Открытая статья (?open=<id>) — например, из цитаты Джарвиса; ссылку можно переслать. */
  open: z.uuid().optional().catch(undefined),
});

export const Route = createFileRoute('/knowledge')({
  beforeLoad: async ({ context }) => {
    await requireAuth(context);
    requireSectionOpen('/knowledge');
  },
  validateSearch: (raw: Record<string, unknown>) => knowledgeSearchSchema.parse(raw),
  component: KnowledgeRoute,
});

function KnowledgeRoute() {
  const { open } = Route.useSearch();
  const navigate = Route.useNavigate();
  return (
    <AppShell>
      <KnowledgePage
        openId={open}
        onOpen={(id) =>
          void navigate({ search: (prev) => ({ ...prev, open: id }), replace: id === undefined })
        }
      />
    </AppShell>
  );
}
