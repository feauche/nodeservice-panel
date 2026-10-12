import { createFileRoute, redirect } from '@tanstack/react-router';
import { requireAuth } from '@/features/auth/guards';
/** Preserve old bookmarks while analysis now belongs to Overview → Statistics. */
export const Route = createFileRoute('/metrics')({
  beforeLoad: async ({ context }) => {
    await requireAuth(context);
    throw redirect({ to: '/', search: { view: 'stats', detail: 'metrics' } });
  },
});
