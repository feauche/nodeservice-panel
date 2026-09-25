import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRouter, RouterProvider } from '@tanstack/react-router';
import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useAuthStore } from '@/features/auth/store';
import { loginMethod } from '@/features/security/security-format';
import { resetMockState } from '@/test/msw/handlers';
import { mockSecurity } from '@/test/msw/security-mock';
import { routeTree } from './routeTree.gen';

// Пока раздел «Настройки» закрыт по этапам — здесь открываем его, чтобы проверять содержимое страниц.
vi.mock('@/lib/stages', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/stages')>()),
  isSectionOpen: () => true,
  requireSectionOpen: () => undefined,
}));

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

describe('маршруты настроек', () => {
  beforeEach(() => {
    sessionStorage.clear();
    useAuthStore.setState({ me: null, hydrated: false, locked: false });
    resetMockState({ authenticated: true, recoveryLeft: 7 });
  });

  it('/settings → /settings/appearance с вкладками и темами', async () => {
    const router = renderAt('/settings');
    expect(await screen.findByRole('heading', { name: 'Настройки' })).toBeInTheDocument();
    await waitFor(() => expect(router.state.location.pathname).toBe('/settings/appearance'));
    expect(screen.getByRole('link', { name: 'Внешний вид' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: 'Безопасность' })).not.toHaveAttribute('aria-current');
    expect(screen.getByRole('button', { name: /^Графит/ })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText('Тема хранится в этом браузере.')).toBeInTheDocument();
  });

  it('вкладка «Безопасность» показывает остаток кодов и способ входа текущей сессии', async () => {
    mockSecurity.recoveryLeft = 7;
    renderAt('/settings/security');
    expect(await screen.findByText('Включена')).toBeInTheDocument();
    expect(await screen.findByText('7 из 10')).toBeInTheDocument();
    expect(await screen.findByText(/Пароль \+ код 2FA/)).toBeInTheDocument();
  });

  it('без сессии /settings уводит на /login', async () => {
    resetMockState({ authenticated: false });
    const router = renderAt('/settings/security');
    await waitFor(() => expect(router.state.location.pathname).toBe('/login'));
  });
});

describe('loginMethod', () => {
  it('переводит amr в подпись', () => {
    expect(loginMethod(['pwd', 'totp'])).toBe('Пароль + код 2FA');
    expect(loginMethod(['pwd', 'recovery'])).toBe('Пароль + код восстановления');
    expect(loginMethod(['pwd', 'trusted'])).toBe('Пароль · запомненное устройство');
    expect(loginMethod(['pwd'])).toBe('Пароль');
    expect(loginMethod(undefined)).toBe('—');
  });
});
