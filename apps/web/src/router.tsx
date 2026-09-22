import { createRouter } from '@tanstack/react-router';

import { queryClient } from '@/lib/query-client';
import { PendingScreen } from './routes/__root';
import { routeTree } from './routeTree.gen';

export const router = createRouter({
  routeTree,
  context: { queryClient },
  defaultPreload: 'intent',
  defaultPendingComponent: PendingScreen,
  defaultPendingMs: 150,
  scrollRestoration: true,
});

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
