import { createFileRoute } from '@tanstack/react-router';
import { AssistantSettingsPage } from '@/features/assistant/assistant-settings-page';
import { requireAuth } from '@/features/auth/guards';

export const Route = createFileRoute('/settings/assistant')({
  beforeLoad: ({ context }) => requireAuth(context),
  component: AssistantSettingsPage,
});
