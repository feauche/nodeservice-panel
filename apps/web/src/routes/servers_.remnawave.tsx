import { createFileRoute, redirect } from '@tanstack/react-router';
import { requireAuth } from '@/features/auth/guards';
/** Existing Remnawave bookmarks now open the node inventory. */
export const Route = createFileRoute('/servers_/remnawave')({
  beforeLoad: async ({ context }) => {
    await requireAuth(context);
    throw redirect({ to: '/nodes', replace: true });
  },
});
