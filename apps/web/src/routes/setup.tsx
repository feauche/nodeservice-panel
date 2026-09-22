import { createFileRoute } from '@tanstack/react-router';

import { requireSetup } from '@/features/auth/guards';
import { SetupPage } from '@/features/auth/pages/setup-page';

export const Route = createFileRoute('/setup')({
  beforeLoad: ({ context }) => requireSetup(context),
  component: SetupPage,
});
