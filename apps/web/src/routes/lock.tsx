import { createFileRoute } from '@tanstack/react-router';

import { requireLocked } from '@/features/auth/guards';
import { LockPage } from '@/features/auth/pages/lock-page';

export const Route = createFileRoute('/lock')({
  beforeLoad: ({ context }) => requireLocked(context),
  component: LockPage,
});
