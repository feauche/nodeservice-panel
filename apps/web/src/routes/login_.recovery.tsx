import { createFileRoute } from '@tanstack/react-router';

import { requirePendingTotp } from '@/features/auth/guards';
import { RecoveryPage } from '@/features/auth/pages/recovery-page';

export const Route = createFileRoute('/login_/recovery')({
  beforeLoad: ({ context }) => requirePendingTotp(context),
  component: RecoveryPage,
});
