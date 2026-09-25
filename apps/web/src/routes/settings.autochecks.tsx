import { createFileRoute } from '@tanstack/react-router';

import { requireAuth } from '@/features/auth/guards';
import { AutochecksPage } from '@/features/settings/autochecks-page';
import { requireSectionOpen } from '@/lib/stages';

export const Route = createFileRoute('/settings/autochecks')({
  beforeLoad: async ({ context }) => {
    await requireAuth(context);
    requireSectionOpen('/settings/autochecks');
  },
  component: AutochecksPage,
});
