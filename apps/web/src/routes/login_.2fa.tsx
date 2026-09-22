import { createFileRoute } from '@tanstack/react-router';

import { requirePendingTotp } from '@/features/auth/guards';
import { TotpPage } from '@/features/auth/pages/totp-page';

export const Route = createFileRoute('/login_/2fa')({
  beforeLoad: ({ context }) => requirePendingTotp(context),
  component: TotpPage,
});
