import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  createMemoryHistory,
  createRootRouteWithContext,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import { render } from '@testing-library/react';
import type { FunctionComponent } from 'react';
import { TooltipProvider } from '@/components/ui/tooltip';
import { StepUpHost } from '@/features/security/step-up-host';

import type { RouterContext } from '@/routes/__root';

/**
 * Минимальный роутер для тестов страниц: компонент под тестом висит на `path`,
 * остальные пути — пустышки, чтобы navigate() было куда идти.
 */
export function renderPage(
  Page: FunctionComponent,
  path: string,
  extraPaths: string[] = [],
  /** Реальный адрес для маршрутов с параметрами: renderPage(Page, '/servers/$serverId', [], '/servers/<id>'). */
  initialUrl: string = path,
) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const rootRoute = createRootRouteWithContext<RouterContext>()({});
  const main = createRoute({ getParentRoute: () => rootRoute, path, component: Page });
  const others = extraPaths.map((p) =>
    createRoute({
      getParentRoute: () => rootRoute,
      path: p,
      component: () => <div data-testid={`page:${p}`} />,
    }),
  );
  const router = createRouter({
    routeTree: rootRoute.addChildren([main, ...others]),
    history: createMemoryHistory({ initialEntries: [initialUrl] }),
    context: { queryClient },
  });
  const utils = render(
    <QueryClientProvider client={queryClient}>
      <TooltipProvider delayDuration={0}>
        {/* biome-ignore lint/suspicious/noExplicitAny: тестовый роутер не регистрируется глобально */}
        <RouterProvider router={router as any} />
        {/* в приложении смонтирован в AppShell — тесты страниц получают его здесь */}
        <StepUpHost />
      </TooltipProvider>
    </QueryClientProvider>,
  );
  return { ...utils, router, queryClient };
}
