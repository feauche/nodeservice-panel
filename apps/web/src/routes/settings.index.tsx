import { createFileRoute, redirect } from '@tanstack/react-router';

import { requireAuth } from '@/features/auth/guards';
import { isSectionOpen } from '@/lib/stages';

export const Route = createFileRoute('/settings/')({
  beforeLoad: async ({ context }) => {
    await requireAuth(context);
    // Первая открытая вкладка: пока их открывают по этапам, «Внешний вид» может быть закрыт.
    throw redirect({
      to: isSectionOpen('/settings/appearance') ? '/settings/appearance' : '/settings/assistant',
      replace: true,
    });
  },
});
