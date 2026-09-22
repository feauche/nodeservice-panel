import { AUTH_PROBLEM } from '@nodeservice/shared';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http } from 'msw';
import { beforeEach, describe, expect, it } from 'vitest';

import { MOCK, problem, resetMockState } from '@/test/msw/handlers';
import { server } from '@/test/msw/server';
import { renderPage } from '@/test/render';
import { SetupPage } from './setup-page';

const PASSWORD = 'correct horse battery staple';

async function fillStep1(user: ReturnType<typeof userEvent.setup>, token: string = MOCK.setupToken) {
  await user.type(await screen.findByLabelText('Токен первого запуска'), token);
  await user.type(screen.getByLabelText('Логин'), MOCK.login);
  await user.type(screen.getByLabelText('Пароль'), PASSWORD);
  await user.type(screen.getByLabelText('Повторите пароль'), PASSWORD);
  await user.click(screen.getByRole('button', { name: 'Создать учётную запись' }));
}

describe('SetupPage', () => {
  it('генератор подставляет один и тот же пароль в оба поля и показывает его', async () => {
    const user = userEvent.setup();
    renderPage(SetupPage, '/setup', ['/']);
    await screen.findByLabelText('Токен первого запуска');
    await user.click(screen.getByRole('button', { name: 'Сгенерировать надёжный пароль' }));
    const pass = screen.getByLabelText('Пароль') as HTMLInputElement;
    const pass2 = screen.getByLabelText('Повторите пароль') as HTMLInputElement;
    // пароль «печатается» по символу — ждём, пока наберётся целиком
    await waitFor(() => expect(pass.value).toMatch(/^[A-Za-z2-9]{4}(-[A-Za-z2-9]{4}){4}$/));
    expect(pass2.value).toBe(pass.value);
    expect(pass).toHaveAttribute('type', 'text');
    expect(pass2).toHaveAttribute('type', 'text');
    // глаз общий для обоих полей: скрыли одно — скрылось и второе
    await user.click(screen.getAllByRole('button', { name: 'Скрыть пароль' })[0] as HTMLElement);
    expect(pass).toHaveAttribute('type', 'password');
    expect(pass2).toHaveAttribute('type', 'password');
  });

  beforeEach(() => resetMockState({ setupRequired: true }));

  it('счастливый путь: три шага → /', async () => {
    const { router } = renderPage(SetupPage, '/setup', ['/']);
    const user = userEvent.setup();

    // шаг 1
    expect(await screen.findByLabelText('Токен первого запуска')).toHaveFocus();
    await fillStep1(user);

    // шаг 2: QR, секрет, код
    expect(await screen.findByRole('heading', { name: 'Двухфакторная защита' })).toBeInTheDocument();
    expect(screen.getByAltText('QR-код для приложения-аутентификатора')).toBeInTheDocument();
    const otp = screen.getByLabelText('Код из приложения, 6 цифр');
    expect(otp).toHaveFocus();
    await user.type(otp, MOCK.totp);

    // шаг 3: коды, фокус на заголовке, чекбокс включает кнопку
    const heading = await screen.findByRole('heading', { name: 'Коды восстановления' });
    expect(heading).toHaveFocus();
    expect(screen.getByText('K7QFM-2M9XT')).toBeInTheDocument();
    const done = screen.getByRole('button', { name: 'Завершить и войти' });
    expect(done).toBeDisabled();
    await user.click(screen.getByLabelText('Коды сохранены в надёжном месте'));
    expect(done).toBeEnabled();
    await user.click(done);
    await waitFor(() => expect(router.state.location.pathname).toBe('/'));
  });

  it('«Назад» со шага 2 возвращает заполненную форму и фокусирует логин', async () => {
    renderPage(SetupPage, '/setup', ['/']);
    const user = userEvent.setup();
    await fillStep1(user);
    await user.click(await screen.findByRole('button', { name: 'Назад' }));
    expect(await screen.findByLabelText('Токен первого запуска')).toHaveValue(MOCK.setupToken);
    expect(screen.getByLabelText('Логин')).toHaveFocus();
  });

  it('422 раскладывается по полям', async () => {
    server.use(
      http.post('/api/auth/setup/start', () =>
        problem(422, AUTH_PROBLEM.validation, 'Данные не прошли проверку', {
          errors: [
            { path: 'login', message: 'Такой логин нельзя' },
            { path: 'setupToken', message: 'Токен уже использован' },
          ],
        }),
      ),
    );
    renderPage(SetupPage, '/setup', ['/']);
    const user = userEvent.setup();
    await fillStep1(user);
    expect(await screen.findByText('Такой логин нельзя')).toBeInTheDocument();
    expect(screen.getByText('Токен уже использован')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Логин')).toHaveAttribute('aria-invalid', 'true');
  });

  it('неверный токен → общая ошибка', async () => {
    renderPage(SetupPage, '/setup', ['/']);
    const user = userEvent.setup();
    await fillStep1(user, 'wrong-token-1234');
    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText(/Токен первого запуска не подошёл/)).toBeInTheDocument();
  });
});
