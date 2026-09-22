import { createFileRoute } from '@tanstack/react-router';

import { AppShell } from '@/components/layout/app-shell';
import { AssistantPage } from '@/features/assistant/assistant-page';
import { requireAuth } from '@/features/auth/guards';
import { requireSectionOpen } from '@/lib/stages';

export const Route = createFileRoute('/assistant')({
  beforeLoad: async ({ context }) => {
    await requireAuth(context);
    requireSectionOpen('/assistant');
  },
  component: AssistantRoute,
});

function AssistantRoute() {
  return (
    <AppShell>
      <AssistantPage />
    </AppShell>
  );
}
