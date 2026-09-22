import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRouter, RouterProvider } from '@tanstack/react-router';
import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';

import { useAuthStore } from '@/features/auth/store';
import { resetMockState } from '@/test/msw/handlers';
import { routeTree } from './routeTree.gen';

/**
 * Регрессия на реальное дерево маршрутов (routeTree.gen.ts): страницы 2FA и восстановления
 * не должны быть вложены в /login — иначе LoginPage без <Outlet/> «съедает» их и на
 * /login/2fa остаётся форма входа (так и было, тесты страниц по отдельности этого не видели).
 */
function renderAt(path: string) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: [path] }),
    context: { queryClient },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return router;
}

describe('закрытые по этапам разделы', () => {
  beforeEach(() => {
    sessionStorage.clear();
    useAuthStore.setState({ me: null, hydrated: false, locked: false });
    resetMockState({ authenticated: true });
  });

  it('/settings и / уводят на «Серверы», пока разделы закрыты', async () => {
    const r1 = renderAt('/settings/security');
    await waitFor(() => expect(r1.state.location.pathname).toBe('/servers'));
    const r2 = renderAt('/');
    await waitFor(() => expect(r2.state.location.pathname).toBe('/servers'));
  });
});

describe('маршруты авторизации', () => {
  beforeEach(() => {
    sessionStorage.clear();
    useAuthStore.getState().setPendingTotp(true);
  });

  it('/login/2fa показывает страницу подтверждения, а не форму входа', async () => {
    const router = renderAt('/login/2fa');
    expect(await screen.findByRole('heading', { name: 'Подтверждение входа' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Вход в панель' })).not.toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/login/2fa');
  });

  it('/login/recovery показывает страницу кода восстановления', async () => {
    renderAt('/login/recovery');
    expect(await screen.findByRole('heading', { name: 'Код восстановления' })).toBeInTheDocument();
  });

  it('/login/2fa без ожидающего входа возвращает на /login', async () => {
    useAuthStore.getState().setPendingTotp(false);
    const router = renderAt('/login/2fa');
    expect(await screen.findByRole('heading', { name: 'Вход в панель' })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/login');
  });
});
