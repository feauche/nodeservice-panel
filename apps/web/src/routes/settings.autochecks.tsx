import { createFileRoute } from '@tanstack/react-router';

import { requireAuth } from '@/features/auth/guards';
import { AutochecksPage } from '@/features/settings/autochecks-page';

export const Route = createFileRoute('/settings/autochecks')({
  beforeLoad: ({ context }) => requireAuth(context),
  component: AutochecksPage,
});
