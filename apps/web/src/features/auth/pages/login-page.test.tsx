import { AUTH_PROBLEM } from '@nodeservice/shared';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http } from 'msw';
import { describe, expect, it } from 'vitest';

import { MOCK, problem } from '@/test/msw/handlers';
import { server } from '@/test/msw/server';
import { renderPage } from '@/test/render';
import { useAuthStore } from '../store';
import { LoginPage } from './login-page';

async function fill(login: string, password: string) {
  const user = userEvent.setup();
  await user.type(await screen.findByLabelText('Логин'), login);
  await user.type(screen.getByLabelText('Пароль'), password);
  await user.click(screen.getByRole('button', { name: 'Войти' }));
  return user;
}

describe('LoginPage', () => {
  it('показывает ошибки валидации и не зовёт API', async () => {
    let called = false;
    server.use(
      http.post('/api/auth/login', () => {
        called = true;
        return problem(500, 'about:blank', 'no');
      }),
    );
    renderPage(LoginPage, '/login');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Войти' }));
    expect(await screen.findByText('Введи логин')).toBeInTheDocument();
    expect(screen.getByText('Введи пароль')).toBeInTheDocument();
    expect(called).toBe(false);
  });

  it('неверный пароль → «Неверный логин или пароль.»', async () => {
    renderPage(LoginPage, '/login');
    await fill('admin', 'wrong-password');
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Неверный логин или пароль.');
    expect(screen.getByLabelText('Пароль')).toHaveValue('');
  });

  it('throttled → отсчёт и заблокированная кнопка', async () => {
    server.use(
      http.post('/api/auth/login', () =>
        problem(429, AUTH_PROBLEM.throttled, 'x', { retryAfterSeconds: 30 }, { 'retry-after': '30' }),
      ),
    );
    renderPage(LoginPage, '/login');
    await fill('admin', 'whatever-pass');
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/Слишком много неудачных попыток/);
    expect(alert).not.toHaveTextContent(/\d:\d\d/);
    expect(document.body).toHaveTextContent(/0:(30|29)/);
    expect(screen.getByRole('button', { name: 'Войти' })).toBeDisabled();
    expect(screen.getByLabelText('Логин')).toBeDisabled();
  });

  it('успех с {next:"totp"} → /login/2fa и флаг pendingTotp', async () => {
    const { router } = renderPage(LoginPage, '/login', ['/login/2fa', '/']);
    await fill(MOCK.login, MOCK.password);
    await waitFor(() => expect(router.state.location.pathname).toBe('/login/2fa'));
    expect(useAuthStore.getState().pendingTotp).toBe(true);
  });

  it('«Забыл пароль?» раскрывает подсказку про Rescue CLI', async () => {
    renderPage(LoginPage, '/login');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Забыл пароль?' }));
    expect(screen.getByText('docker exec -it nodeservice cli')).toBeInTheDocument();
  });
});
