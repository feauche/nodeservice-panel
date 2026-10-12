import { createFileRoute } from '@tanstack/react-router';
import { AppShell } from '@/components/layout/app-shell';
import { requireAuth } from '@/features/auth/guards';
import { ScenariosPage } from '@/features/scenarios/scenarios-page';
export const Route = createFileRoute('/scenarios')({
  beforeLoad: async ({ context }) => {
    await requireAuth(context);
  },
  component: () => (
    <AppShell title="Сценарии" subtitle="Правила проверки и действия для всех или выбранных нод">
      <ScenariosPage />
    </AppShell>
  ),
});
