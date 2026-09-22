import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';

import { MOCK, resetMockState } from '@/test/msw/handlers';
import { MOCK_SECURITY, mockSecurity } from '@/test/msw/security-mock';
import { renderPage } from '@/test/render';
import { SecurityPage } from './security-page';

describe('SecurityPage', () => {
  beforeEach(() => {
    resetMockState({ authenticated: true });
  });

  it('показывает сводку: 2FA включена, коды, сессии с «текущая», запомненные устройства', async () => {
    renderPage(SecurityPage, '/settings/security', ['/lock']);
    expect(await screen.findByText('включена')).toBeInTheDocument();
    expect(await screen.findByText('8 из 10')).toBeInTheDocument();
    const sessions = await screen.findByRole('list', { name: 'Активные сессии' });
    await waitFor(() => expect(within(sessions).getAllByRole('listitem')).toHaveLength(2));
    expect(within(sessions).getByText('текущая')).toBeInTheDocument();
    expect(within(sessions).getByText('198.51.100.20')).toBeInTheDocument();
    const devices = await screen.findByRole('list', { name: 'Запомненные устройства' });
    expect(within(devices).getByText('это устройство')).toBeInTheDocument();
    expect(screen.getByText(/Последняя смена — 1 августа 2026/)).toBeInTheDocument();
  });

  it('смена пароля: неверный текущий — ошибка у поля; верный — сессии завершены', async () => {
    renderPage(SecurityPage, '/settings/security');
    const user = userEvent.setup();
    await screen.findByText('включена');
    await user.type(screen.getByLabelText('Текущий пароль'), 'wrong password 123');
    await user.type(screen.getByLabelText('Новый пароль'), 'a brand new passphrase');
    await user.click(screen.getByRole('button', { name: 'Сменить пароль' }));
    expect(await screen.findByText('Неверный текущий пароль')).toBeInTheDocument();

    await user.clear(screen.getByLabelText('Текущий пароль'));
    await user.type(screen.getByLabelText('Текущий пароль'), MOCK.password);
    await user.click(screen.getByRole('button', { name: 'Сменить пароль' }));
    await waitFor(() => expect(mockSecurity.sessions).toHaveLength(1));
    // поля очищены после успеха
    await waitFor(() => expect(screen.getByLabelText('Текущий пароль')).toHaveValue(''));
  });

  it('пароль из утечек — сообщение у поля нового пароля', async () => {
    renderPage(SecurityPage, '/settings/security');
    const user = userEvent.setup();
    await screen.findByText('включена');
    await user.type(screen.getByLabelText('Текущий пароль'), MOCK.password);
    await user.type(screen.getByLabelText('Новый пароль'), MOCK_SECURITY.pwnedPassword);
    await user.click(screen.getByRole('button', { name: 'Сменить пароль' }));
    expect(await screen.findByText('Пароль есть в утечках — выбери другой')).toBeInTheDocument();
  });

  it('политика: сохранение просит пароль (step-up), после подтверждения — сохранено', async () => {
    mockSecurity.stepUpFresh = false;
    renderPage(SecurityPage, '/settings/security');
    const user = userEvent.setup();
    const toggle = await screen.findByRole('switch', { name: '' });
    await user.click(toggle);
    await user.click(screen.getByRole('button', { name: 'Сохранить' }));
    const dialog = await screen.findByRole('dialog', { name: 'Подтверди пароль' });
    await user.type(within(dialog).getByLabelText('Пароль'), 'wrong');
    await user.click(within(dialog).getByRole('button', { name: 'Подтвердить' }));
    expect(await within(dialog).findByText(/Неверный/)).toBeInTheDocument();
    await user.clear(within(dialog).getByLabelText('Пароль'));
    await user.type(within(dialog).getByLabelText('Пароль'), MOCK.password);
    await user.click(within(dialog).getByRole('button', { name: 'Подтвердить' }));
    await waitFor(() => expect(mockSecurity.policy.alwaysAskTotp).toBe(true));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Сохранить' })).toBeDisabled(); // сохранено — не dirty
  });

  it('отмена step-up не меняет ничего', async () => {
    mockSecurity.stepUpFresh = false;
    renderPage(SecurityPage, '/settings/security');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('switch'));
    await user.click(screen.getByRole('button', { name: 'Сохранить' }));
    const dialog = await screen.findByRole('dialog', { name: 'Подтверди пароль' });
    await user.click(within(dialog).getByRole('button', { name: 'Отмена' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(mockSecurity.policy.alwaysAskTotp).toBe(false);
  });

  it('новые коды восстановления: подтверждение → 10 кодов, закрыть можно только после галочки', async () => {
    renderPage(SecurityPage, '/settings/security');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: /Выпустить новые/ }));
    await user.click(await screen.findByRole('button', { name: 'Да, выпустить' }));
    const list = await screen.findByTestId('recovery-codes');
    expect(within(list).getAllByRole('listitem')).toHaveLength(10);
    expect(screen.getByRole('button', { name: 'Готово' })).toBeDisabled();
    await user.click(screen.getByLabelText('Я сохранил коды в надёжном месте'));
    await user.click(screen.getByRole('button', { name: 'Готово' }));
    await waitFor(() => expect(screen.queryByTestId('recovery-codes')).not.toBeInTheDocument());
  });

  it('сессии: завершить чужую через подтверждение; текущую завершить нельзя', async () => {
    renderPage(SecurityPage, '/settings/security');
    const user = userEvent.setup();
    const sessions = await screen.findByRole('list', { name: 'Активные сессии' });
    await waitFor(() => expect(within(sessions).getAllByRole('listitem')).toHaveLength(2));
    const buttons = within(sessions).getAllByRole('button', { name: 'Завершить' });
    expect(buttons[0]).toBeDisabled(); // текущая
    await user.click(buttons[1] as HTMLElement);
    await user.click(await screen.findByRole('button', { name: 'Да, завершить' }));
    await waitFor(() => expect(within(sessions).getAllByRole('listitem')).toHaveLength(1));
    expect(mockSecurity.sessions).toHaveLength(1);
  });

  it('устройства: забыть одно — список пустеет с подсказкой', async () => {
    renderPage(SecurityPage, '/settings/security');
    const user = userEvent.setup();
    const devices = await screen.findByRole('list', { name: 'Запомненные устройства' });
    await user.click(await within(devices).findByRole('button', { name: 'Забыть' }));
    await user.click(await screen.findByRole('button', { name: 'Да, забыть' }));
    await waitFor(() => expect(mockSecurity.devices).toHaveLength(0));
    expect(await within(devices).findByText(/Пока нет/)).toBeInTheDocument();
  });

  it('перевыпуск 2FA: QR и ключ, неверный код — ошибка, верный — устройства сброшены', async () => {
    renderPage(SecurityPage, '/settings/security');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: /Перевыпустить/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Перевыпуск 2FA' });
    expect(await within(dialog).findByText(MOCK_SECURITY.totpSecret)).toBeInTheDocument();
    expect(within(dialog).getByRole('img', { name: /QR/ })).toBeInTheDocument();
    await user.type(within(dialog).getByLabelText('Код из приложения, 6 цифр'), '000000');
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(/Неверный код/);
    await user.type(within(dialog).getByLabelText('Код из приложения, 6 цифр'), MOCK_SECURITY.totpCode);
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Перевыпуск 2FA' })).not.toBeInTheDocument(),
    );
    expect(mockSecurity.devices).toHaveLength(0);
  });

  it('просмотр кодов: за step-up, использованные зачёркнуты, закрыть можно сразу', async () => {
    mockSecurity.stepUpFresh = false;
    renderPage(SecurityPage, '/settings/security');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Показать' }));
    const dialog = await screen.findByRole('dialog', { name: 'Подтверди пароль' });
    await user.type(within(dialog).getByLabelText('Пароль'), MOCK.password);
    await user.click(within(dialog).getByRole('button', { name: 'Подтвердить' }));
    const list = await screen.findByTestId('recovery-codes');
    expect(within(list).getAllByRole('listitem')).toHaveLength(10);
    expect(list.querySelectorAll('s')).toHaveLength(2);
    expect(screen.getByRole('button', { name: 'Закрыть' })).toBeEnabled();
    await user.click(screen.getByRole('button', { name: 'Закрыть' }));
    await waitFor(() => expect(screen.queryByTestId('recovery-codes')).not.toBeInTheDocument());
  });

  it('коды без шифрованной копии: объяснение и кнопка «Выпустить новые» вместо сетки', async () => {
    mockSecurity.codes = mockSecurity.codes.map((c) => ({ ...c, code: null }));
    renderPage(SecurityPage, '/settings/security');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Показать' }));
    expect(await screen.findByTestId('recovery-codes-legacy')).toBeInTheDocument();
    expect(screen.queryByTestId('recovery-codes')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Выпустить новые' }));
    await user.click(await screen.findByRole('button', { name: 'Да, выпустить' }));
    expect(within(await screen.findByTestId('recovery-codes')).getAllByRole('listitem')).toHaveLength(10);
  });
});
