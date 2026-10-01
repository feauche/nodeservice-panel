import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRouter, RouterProvider } from '@tanstack/react-router';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';

import { useAuthStore } from '@/features/auth/store';
import { useStepUpStore } from '@/features/security/step-up';
import { routeTree } from '@/routeTree.gen';
import { MOCK, resetMockState } from '@/test/msw/handlers';

/** Настоящее дерево маршрутов: хосты окон смонтированы в корне, над разделами. */
function renderApp(path: string) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
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

/** Чувствительное действие страницы просит пароль (как withStepUp при удалении сервера). */
function requestStepUp(): { answer: () => boolean | undefined } {
  let answer: boolean | undefined;
  act(() => {
    void useStepUpStore
      .getState()
      .request()
      .then((ok) => {
        answer = ok;
      });
  });
  return { answer: () => answer };
}

describe('SessionHosts: запрос пароля относится к странице, где его вызвали', () => {
  beforeEach(() => {
    sessionStorage.clear();
    useAuthStore.setState({ me: null, hydrated: false, locked: false });
    useStepUpStore.setState({ open: false, resolve: null });
    resetMockState({ authenticated: true });
  });

  it('«назад» в браузере при открытом запросе пароля отменяет действие покинутой страницы', async () => {
    const router = renderApp('/incidents');
    await screen.findByRole('heading', { level: 1, name: 'Инциденты' });
    await act(() => router.navigate({ to: '/servers' }));
    await screen.findByRole('heading', { level: 1, name: 'Серверы' });

    const pending = requestStepUp();
    expect(await screen.findByRole('dialog', { name: 'Подтвердите пароль' })).toBeInTheDocument();

    // Пока открыт модальный запрос, уйти со страницы можно только кнопкой или жестом «назад».
    act(() => router.history.back());
    await screen.findByRole('heading', { level: 1, name: 'Инциденты' });
    // Пароль, введённый уже на «Инцидентах», не должен выполнить удаление сервера со «Серверов».
    await waitFor(() => expect(pending.answer()).toBe(false));
    expect(screen.queryByRole('dialog', { name: 'Подтвердите пароль' })).toBeNull();
  });

  it('без ухода со страницы запрос ждёт пароля и после него выполняет действие', async () => {
    renderApp('/servers');
    await screen.findByRole('heading', { level: 1, name: 'Серверы' });

    const pending = requestStepUp();
    const dialog = await screen.findByRole('dialog', { name: 'Подтвердите пароль' });
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText('Пароль'), MOCK.password);
    await user.click(screen.getByRole('button', { name: 'Подтвердить' }));
    await waitFor(() => expect(pending.answer()).toBe(true));
    expect(dialog).not.toBeInTheDocument();
  });
});
