import { QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';
import { createRoot } from 'react-dom/client';
import { installSessionExpiry } from '@/features/auth/queries';
import { initTheme } from '@/features/theme/theme';
import { queryClient } from '@/lib/query-client';
import { router } from '@/router';

import './index.css';

initTheme();
installSessionExpiry(queryClient, router);

async function bootstrap() {
  // Dev-режим без бэкенда: VITE_MOCK=1 pnpm dev — MSW отвечает за /api.
  if (import.meta.env.DEV && import.meta.env.VITE_MOCK === '1') {
    const { startMockWorker } = await import('./mocks/browser');
    await startMockWorker();
  }

  const rootEl = document.getElementById('root');
  if (!rootEl) throw new Error('#root not found');

  // Без StrictMode: его dev-двойной прогон эффектов отменяет ещё летящие запросы TanStack Query
  // и превращал безобидную отмену в экран ошибки. В проде двойного прогона нет — поведение не меняется.
  createRoot(rootEl).render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

void bootstrap();
