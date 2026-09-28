import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetMockState } from '@/test/msw/handlers';
import { mockTelegram } from '@/test/msw/telegram-mock';
import { renderPage } from '@/test/render';
import { NotificationsPage } from './notifications-page';

const TOKEN = '123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw';

describe('NotificationsPage', () => {
  beforeEach(() => resetMockState({ authenticated: true }));

  it('добавить чат: неверная ссылка подсвечена и не сохраняется; верная — тест, сохранение, токен скрыт', async () => {
    renderPage(NotificationsPage, '/settings/notifications');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Добавить чат' }));
    const input = screen.getByRole('textbox', { name: 'Ссылка на чат Telegram' });
    await user.type(input, 'tgram://плохо');
    expect(screen.getByText(/Не похоже на ссылку/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Сохранить' })).toBeDisabled();

    await user.clear(input);
    await user.type(input, `tgram://${TOKEN}/-1002946167407:8`);
    await user.click(screen.getByRole('button', { name: 'Отправить тестовое сообщение' }));
    expect(await screen.findByText('Тест доставлен')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Сохранить' }));
    expect(await screen.findByText('tgram://***/-1002946167407:8')).toBeInTheDocument();
    expect(document.body.textContent).not.toContain(TOKEN);
    expect(mockTelegram.settings.destinations).toHaveLength(1);
  });

  it('ошибка Telegram видна под строкой; удаление убирает чат после сохранения', async () => {
    mockTelegram.settings.destinations = [
      {
        id: 'tg-x',
        masked: 'tgram://***/-100999',
        chatId: '-100999',
        topic: null,
        botName: '@lumax_alert_bot',
        chatTitle: null,
        lastTest: null,
      },
    ];
    renderPage(NotificationsPage, '/settings/notifications');
    const user = userEvent.setup();
    const row = (await screen.findAllByTestId('tg-row'))[0] as HTMLElement;
    await user.click(within(row).getByRole('button', { name: 'Отправить тестовое сообщение' }));
    expect(await within(row).findByText(/добавьте бота в группу/)).toBeInTheDocument();
    await user.click(within(row).getByRole('button', { name: 'Удалить чат' }));
    await user.click(screen.getByRole('button', { name: 'Сохранить' }));
    await waitFor(() => expect(mockTelegram.settings.destinations).toHaveLength(0));
  });

  it('тумблеры событий и тихие часы сохраняются', async () => {
    renderPage(NotificationsPage, '/settings/notifications');
    const user = userEvent.setup();
    await screen.findByText('Что присылать');
    const maint = document.getElementById('tg-ev-maintenance') as HTMLElement;
    await user.click(maint);
    await user.click(document.getElementById('tg-quiet') as HTMLElement);
    await user.click(screen.getByRole('button', { name: 'Сохранить' }));
    await waitFor(() => expect(mockTelegram.settings.events.maintenance).toBe(true));
    expect(mockTelegram.settings.quiet.enabled).toBe(true);
  });

  it('какие инциденты и как присылать: выключить SSH, без склейки, напоминать раз в 4 ч', async () => {
    renderPage(NotificationsPage, '/settings/notifications');
    const user = userEvent.setup();
    await screen.findByText('Какие инциденты');
    await user.click(document.getElementById('tg-kind-ssh_down') as HTMLElement);
    await user.click(document.getElementById('tg-group') as HTMLElement);
    await user.selectOptions(screen.getByRole('combobox', { name: 'Как часто напоминать' }), '4');
    await user.click(screen.getByRole('button', { name: 'Сохранить' }));
    await waitFor(() => expect(mockTelegram.settings.kinds.ssh_down).toBe(false));
    expect(mockTelegram.settings.kinds.agent_offline).toBe(true);
    expect(mockTelegram.settings.delivery).toMatchObject({ groupPerServer: false, remindHours: 4 });
  });
});
