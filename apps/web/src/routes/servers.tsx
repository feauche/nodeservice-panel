import { createFileRoute, redirect } from '@tanstack/react-router';
import { z } from 'zod';
import { requireAuth } from '@/features/auth/guards';
/** Compatibility for existing bookmarks; the server management page is removed. */
export const Route = createFileRoute('/servers')({
  validateSearch: (raw: Record<string, unknown>) =>
    z
      .object({ open: z.uuid().optional().catch(undefined), tag: z.string().optional().catch(undefined) })
      .parse(raw),
  beforeLoad: async ({ context }) => {
    await requireAuth(context);
    throw redirect({ to: '/nodes', replace: true });
  },
});
