import { setupWorker } from 'msw/browser';
import { mockAssistant } from '@/test/msw/assistant-mock';
import { handlers, resetMockState } from '@/test/msw/handlers';
import { mockIncidents } from '@/test/msw/incidents-mock';
import { mockProviders } from '@/test/msw/providers-mock';

/**
 * Dev без бэкенда: VITE_MOCK=1 pnpm dev.
 * Данные: логин admin · пароль «correct horse battery» · код 2FA 123456 · токен setup-token-123456.
 * VITE_MOCK_SETUP=1 — стартовать с мастера первого запуска.
 */
export async function startMockWorker(): Promise<void> {
  resetMockState({ setupRequired: import.meta.env.VITE_MOCK_SETUP === '1' });
  mockProviders.iconDelayMs = 2500;
  (window as unknown as { __nsMockAssistant: typeof mockAssistant }).__nsMockAssistant = mockAssistant;
  (window as unknown as { __nsMockIncidents: typeof mockIncidents }).__nsMockIncidents = mockIncidents;
  const worker = setupWorker(...handlers);
  await worker.start({ onUnhandledRequest: 'bypass', quiet: false });
}
