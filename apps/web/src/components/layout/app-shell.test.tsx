import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useAuthStore } from '@/features/auth/store';
import { mockMe, resetMockState } from '@/test/msw/handlers';
import { server } from '@/test/msw/server';
import { renderPage } from '@/test/render';
import { AppShell, resetNavGroupState } from './app-shell';

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
    resetNavGroupState();
  });

  it('в рейле открыты все разделы: Обзор, Серверы, Инциденты, Журнал, Настройки, Ассистент и База знаний', async () => {
    renderPage(Page, '/', ['/login', '/lock', '/servers', '/incidents', '/settings', '/settings/security']);
    expect(await screen.findByRole('link', { name: 'Серверы' })).toHaveAttribute('href', '/servers');
    expect(screen.getByRole('link', { name: 'Обзор' })).toHaveAttribute('href', '/');
    expect(screen.getByRole('link', { name: 'Журнал' })).toHaveAttribute('href', '/audit');
    expect(screen.getByRole('link', { name: /Инциденты/ })).toHaveAttribute('href', '/incidents');
    expect(screen.getByRole('link', { name: 'Настройки' })).toHaveAttribute('href', '/settings');
    expect(screen.getByRole('link', { name: 'Ассистент' })).toHaveAttribute('href', '/assistant');
    expect(screen.getByRole('link', { name: 'База знаний' })).toHaveAttribute('href', '/knowledge');
  });

  it('«Серверы» раскрываются в «Все серверы» и «Провайдеры»; шеврон сворачивает подпункты', async () => {
    const { router } = renderPage(Page, '/', ['/login', '/lock', '/servers', '/servers/providers']);
    const toggle = await screen.findByRole('button', { name: 'Показать подпункты «Серверы»' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    // вне раздела подпункты скрыты (inert) и не в фокусе
    expect(screen.getByRole('link', { name: 'Серверы' })).toHaveAttribute('href', '/servers');
    const user = userEvent.setup();
    await user.click(toggle);
    expect(screen.getByRole('button', { name: 'Скрыть подпункты «Серверы»' })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    expect(screen.getByRole('link', { name: 'Все серверы' })).toHaveAttribute('href', '/servers');
    expect(screen.getByRole('link', { name: 'Провайдеры' })).toHaveAttribute('href', '/servers/providers');
    await user.click(screen.getByRole('link', { name: 'Провайдеры' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/servers/providers'));
  });

  it('клик по самому пункту «Серверы» раскрывает подпункты, переход в другой раздел их не сворачивает', async () => {
    // Каждый раздел рисует свой AppShell — меню создаётся заново при переходе, как в приложении.
    const pages = { '/servers': Page, '/incidents': Page };
    const { router } = renderPage(Page, '/', ['/servers', '/incidents'], '/', pages);
    const user = userEvent.setup();
    const toggle = () => screen.getByRole('button', { name: /подпункты «Серверы»/ });
    expect(await screen.findByRole('button', { name: 'Показать подпункты «Серверы»' })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
    // не на шеврон, а на сам пункт
    await user.click(screen.getByRole('link', { name: 'Серверы' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/servers'));
    await waitFor(() => expect(toggle()).toHaveAttribute('aria-expanded', 'true'));
    // уходим в «Инциденты» — группа остаётся раскрытой
    await user.click(screen.getByRole('link', { name: /Инциденты/ }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/incidents'));
    await waitFor(() => expect(toggle()).toHaveAttribute('aria-expanded', 'true'));
    // свернули руками — и это тоже запоминается при следующем переходе
    await user.click(toggle());
    expect(toggle()).toHaveAttribute('aria-expanded', 'false');
    await user.click(screen.getByRole('link', { name: 'Обзор' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/'));
    await waitFor(() => expect(toggle()).toHaveAttribute('aria-expanded', 'false'));
  });

  it('в свёрнутом рейле «Серверы» — всплывающее меню с подпунктами', async () => {
    renderPage(Page, '/', ['/login', '/lock', '/servers', '/servers/providers']);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Свернуть меню' }));
    await user.click(screen.getByRole('button', { name: 'Серверы' }));
    expect(await screen.findByRole('menuitem', { name: 'Все серверы' })).toHaveAttribute('href', '/servers');
    expect(screen.getByRole('menuitem', { name: 'Провайдеры' })).toHaveAttribute(
      'href',
      '/servers/providers',
    );
    await user.keyboard('{Escape}');
    await user.click(screen.getByRole('button', { name: 'Развернуть меню' }));
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
