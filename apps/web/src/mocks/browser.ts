import { setupWorker } from 'msw/browser';

import { handlers, resetMockState } from '@/test/msw/handlers';
import { mockMaintenance } from '@/test/msw/maintenance-mock';
import { installMockTerminalSocket } from './terminal-ws';

/**
 * Dev без бэкенда: VITE_MOCK=1 pnpm dev.
 * Данные: логин admin · пароль «correct horse battery» · код 2FA 123456 · токен setup-token-123456.
 * VITE_MOCK_SETUP=1 — стартовать с мастера первого запуска.
 */
export async function startMockWorker(): Promise<void> {
  resetMockState({ setupRequired: import.meta.env.VITE_MOCK_SETUP === '1' });
  // В браузере шаги обслуживания идут «как на живом» — видно прогресс.
  mockMaintenance.speedMs = 1400;
  (window as unknown as { __nsMockMaintenance: typeof mockMaintenance }).__nsMockMaintenance =
    mockMaintenance;
  installMockTerminalSocket();
  const worker = setupWorker(...handlers);
  await worker.start({ onUnhandledRequest: 'bypass', quiet: false });
}
