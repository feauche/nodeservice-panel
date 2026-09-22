import { createFileRoute } from '@tanstack/react-router';

import { requireGuest } from '@/features/auth/guards';
import { LoginPage } from '@/features/auth/pages/login-page';

export const Route = createFileRoute('/login')({
  beforeLoad: ({ context }) => requireGuest(context),
  component: LoginPage,
});
