import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useAuthStore } from '@/features/auth/store';
import { mockMe, resetMockState } from '@/test/msw/handlers';
import { server } from '@/test/msw/server';
import { renderPage } from '@/test/render';
import { AppShell } from './app-shell';

function Page() {
  return (
    <AppShell title="Обзор">
      <div>содержимое</div>
    </AppShell>
  );
}

describe('AppShell · меню пользователя', () => {
  beforeEach(() => {
    resetMockState({ authenticated: true });
    useAuthStore.setState({ me: mockMe, hydrated: true });
  });

  it('в рейле открыты «Обзор», «Серверы» и «Журнал», остальные — под замком без перехода', async () => {
    renderPage(Page, '/', ['/login', '/lock', '/servers', '/settings', '/settings/security']);
    expect(await screen.findByRole('link', { name: 'Серверы' })).toHaveAttribute('href', '/servers');
    expect(screen.getByRole('link', { name: 'Обзор' })).toHaveAttribute('href', '/');
    expect(screen.getByRole('link', { name: 'Журнал' })).toHaveAttribute('href', '/audit');
    for (const name of ['Инциденты', 'Настройки', 'Ассистент', 'База знаний']) {
      expect(screen.queryByRole('link', { name })).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name })).toBeDisabled();
    }
  });

  it('«Выйти» сначала спрашивает; logout не вызывается до «Да»', async () => {
    const logoutCalls = vi.fn();
    server.use(
      http.post('/api/auth/logout', () => {
        logoutCalls();
        return new HttpResponse(null, { status: 204 });
      }),
    );
    const { router } = renderPage(Page, '/', ['/login', '/lock', '/settings', '/settings/security']);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Учётная запись' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Выйти' }));

    expect(await screen.findByRole('alertdialog', { name: 'Выйти из панели?' })).toBeInTheDocument();
    expect(logoutCalls).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Нет' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
    expect(logoutCalls).not.toHaveBeenCalled();
    expect(useAuthStore.getState().me).not.toBeNull();

    await user.click(screen.getByRole('button', { name: 'Учётная запись' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Выйти' }));
    await user.click(await screen.findByRole('button', { name: 'Да, выйти' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/login'));
    expect(logoutCalls).toHaveBeenCalledTimes(1);
    expect(useAuthStore.getState().me).toBeNull();
  });
});
