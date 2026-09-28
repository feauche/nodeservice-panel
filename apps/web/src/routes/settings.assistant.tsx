import { createFileRoute } from '@tanstack/react-router';
import { type AssistantSectionKey, assistantSectionOf } from '@/features/assistant/assistant-sections';
import { AssistantSettingsPage } from '@/features/assistant/assistant-settings-page';
import { requireAuth } from '@/features/auth/guards';

export const Route = createFileRoute('/settings/assistant')({
  // Подраздел в адресе (`?s=permissions`): на него ведут ссылки в рейке настроек.
  validateSearch: (raw: Record<string, unknown>): { s?: AssistantSectionKey } =>
    raw.s === undefined ? {} : { s: assistantSectionOf(raw.s) },
  beforeLoad: ({ context }) => requireAuth(context),
  component: AssistantSettingsPage,
});
