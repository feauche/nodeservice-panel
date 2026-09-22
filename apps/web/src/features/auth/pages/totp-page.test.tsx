import { AUTH_PROBLEM } from '@nodeservice/shared';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import { beforeEach, describe, expect, it } from 'vitest';

import { MOCK, mockMe, problem, resetMockState } from '@/test/msw/handlers';
import { server } from '@/test/msw/server';
import { renderPage } from '@/test/render';
import { useAuthStore } from '../store';
import { TotpPage } from './totp-page';

const otp = () => screen.findByLabelText('Код из приложения, 6 цифр');

describe('TotpPage', () => {
  beforeEach(() => {
    resetMockState({ pendingTotp: true });
    useAuthStore.setState({ me: null, pendingTotp: true, recoveryCodesLeft: null });
  });

  it('6 цифр → POST {code, rememberDevice} → /', async () => {
    let body: unknown;
    server.use(
      http.post('/api/auth/login/totp', async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({ me: mockMe });
      }),
    );
    const { router } = renderPage(TotpPage, '/login/2fa', ['/', '/login', '/login/recovery']);
    const user = userEvent.setup();
    const input = await otp();
    expect(input).toHaveFocus();
    await user.click(screen.getByLabelText('Не спрашивать код на этом устройстве 30 дней'));
    await user.type(input, MOCK.totp);
    await waitFor(() => expect(router.state.location.pathname).toBe('/'));
    expect(body).toEqual({ code: MOCK.totp, rememberDevice: true });
    expect(useAuthStore.getState().me?.login).toBe(MOCK.login);
    expect(useAuthStore.getState().pendingTotp).toBe(false);
  });

  it('неверный код → ошибка, поле очищается', async () => {
    renderPage(TotpPage, '/login/2fa', ['/']);
    const user = userEvent.setup();
    await user.type(await otp(), '000000');
    expect(await screen.findByRole('alert')).toHaveTextContent('Неверный код');
    await waitFor(() => expect(screen.getByLabelText('Код из приложения, 6 цифр')).toHaveValue(''));
  });

  it('throttled → отсчёт, поле и кнопка недоступны', async () => {
    server.use(
      http.post('/api/auth/login/totp', () =>
        problem(429, AUTH_PROBLEM.throttled, 'x', { retryAfterSeconds: 45 }, { 'retry-after': '45' }),
      ),
    );
    renderPage(TotpPage, '/login/2fa', ['/']);
    const user = userEvent.setup();
    await user.type(await otp(), '111111');
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/Слишком много неудачных попыток/);
    expect(alert).not.toHaveTextContent(/\d:\d\d/);
    expect(document.body).toHaveTextContent(/0:4[45]/);
    expect(screen.getByRole('button', { name: 'Подтвердить' })).toBeDisabled();
    expect(screen.getByLabelText('Код из приложения, 6 цифр')).toBeDisabled();
  });

  it('ссылка на код восстановления — только пока коды есть', async () => {
    useAuthStore.setState({ recoveryCodesLeft: 2 });
    const { unmount } = renderPage(TotpPage, '/login/2fa', ['/login/recovery']);
    expect(await screen.findByRole('link', { name: /код восстановления/ })).toBeInTheDocument();
    unmount();

    useAuthStore.setState({ recoveryCodesLeft: 0 });
    renderPage(TotpPage, '/login/2fa', ['/login/recovery']);
    expect(await screen.findByText(/Кодов восстановления не осталось/)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /код восстановления/ })).not.toBeInTheDocument();
  });

  it('«← Назад» снимает pendingTotp', async () => {
    const { router } = renderPage(TotpPage, '/login/2fa', ['/login']);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('link', { name: '← Назад' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/login'));
    expect(useAuthStore.getState().pendingTotp).toBe(false);
    expect(sessionStorage.getItem('ns-pending-totp')).toBeNull();
  });
});
