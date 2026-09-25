import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import { beforeEach, describe, expect, it } from 'vitest';

import { MOCK, mockMe, resetMockState } from '@/test/msw/handlers';
import { server } from '@/test/msw/server';
import { renderPage } from '@/test/render';
import { useAuthStore } from '../store';
import { LockPage } from './lock-page';

describe('LockPage', () => {
  beforeEach(() => {
    resetMockState({ authenticated: true });
    useAuthStore.setState({ me: mockMe, hydrated: true });
    useAuthStore.getState().lock();
  });

  it('показывает логин и фокусирует пароль', async () => {
    renderPage(LockPage, '/lock', ['/', '/login']);
    expect(await screen.findByText(/admin · Сессия сохранена/)).toBeInTheDocument();
    expect(screen.getByLabelText('Пароль')).toHaveFocus();
  });

  it('неверный пароль → ошибка, поле очищено', async () => {
    renderPage(LockPage, '/lock', ['/', '/login']);
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText('Пароль'), 'wrong');
    await user.click(screen.getByRole('button', { name: 'Разблокировать' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Неверный логин или пароль.');
    expect(screen.getByLabelText('Пароль')).toHaveValue('');
    expect(useAuthStore.getState().locked).toBe(true);
  });

  it('верный пароль → unlock и /', async () => {
    const { router } = renderPage(LockPage, '/lock', ['/', '/login']);
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText('Пароль'), MOCK.password);
    await user.click(screen.getByRole('button', { name: 'Разблокировать' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/'));
    expect(useAuthStore.getState().locked).toBe(false);
    expect(sessionStorage.getItem('ns-locked')).toBeNull();
  });

  it('«Выйти» при упавшем сервере всё равно уводит на /login', async () => {
    server.use(http.post('/api/auth/logout', () => HttpResponse.error()));
    const { router } = renderPage(LockPage, '/lock', ['/', '/login']);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Выйти из учётной записи' }));
    expect(await screen.findByRole('alertdialog', { name: 'Выйти из панели?' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Да, выйти' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/login'));
    const st = useAuthStore.getState();
    expect(st.me).toBeNull();
    expect(st.locked).toBe(false);
  });
});
