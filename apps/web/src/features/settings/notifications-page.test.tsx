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
        lastDelivery: null,
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

  it('настоящая доставка видна рядом с тестом: сообщение не дошло — причина и красная точка, хотя тест когда-то прошёл', async () => {
    const hourAgo = new Date(Date.now() - 3_600_000).toISOString();
    const weeksAgo = new Date(Date.now() - 21 * 86_400_000).toISOString();
    const chat = {
      masked: 'tgram://***/-1002946167407',
      chatId: '-1002946167407',
      topic: null,
      botName: '@lumax_alert_bot',
      chatTitle: 'VPN-алерты',
    };
    mockTelegram.settings.destinations = [
      {
        ...chat,
        id: 'tg-broken',
        lastTest: { at: weeksAgo, ok: true, detail: 'Тест доставлен' },
        lastDelivery: {
          at: hourAgo,
          ok: false,
          detail: 'Чат не найден: добавьте бота в группу или проверьте id чата.',
        },
      },
      {
        ...chat,
        id: 'tg-fine',
        masked: 'tgram://***/412345678',
        chatId: '412345678',
        lastTest: null,
        lastDelivery: { at: hourAgo, ok: true, detail: 'Доставлено' },
      },
    ];
    renderPage(NotificationsPage, '/settings/notifications');
    const [broken, fine] = (await screen.findAllByTestId('tg-row')) as [HTMLElement, HTMLElement];
    expect(screen.getByText('Есть ошибка доставки')).toBeInTheDocument();
    expect(screen.getByText('Ошибки доставки')).toBeInTheDocument();
    // Тест трёхнедельной давности остаётся в строке, но «зелёным» чат больше не выглядит.
    expect(within(broken).getByText(/тест доставлен/)).toBeInTheDocument();
    const failed = within(broken).getByText(
      'последнее сообщение не дошло 1 ч назад: Чат не найден: добавьте бота в группу или проверьте id чата.',
    );
    expect(failed).toHaveClass('text-crit');
    expect(broken.querySelector('span.rounded-full')).toHaveClass('bg-crit');
    // Чат без теста, в который сообщения доходят, — зелёный по настоящей доставке.
    expect(within(fine).getByText('последнее сообщение доставлено 1 ч назад')).toHaveClass('text-ok');
    expect(fine.querySelector('span.rounded-full')).toHaveClass('bg-ok');
  });

  it('тихие часы: подписано, по какому поясу они работают', async () => {
    mockTelegram.settings.timeZone = 'Asia/Omsk';
    mockTelegram.settings.timeZoneChosen = true;
    const first = renderPage(NotificationsPage, '/settings/notifications');
    expect(
      await screen.findByText(
        'С 23:00 до 08:00 по часовому поясу панели (Омск · UTC+6). Пояс выбирается в «Настройки → Внешний вид».',
      ),
    ).toBeInTheDocument();
    first.unmount();
    // Пояс панели ещё не выбран: работает пояс браузера из последнего сохранения — так и написано.
    mockTelegram.settings.timeZone = 'Europe/Moscow';
    mockTelegram.settings.timeZoneChosen = false;
    renderPage(NotificationsPage, '/settings/notifications');
    expect(
      await screen.findByText(
        /С 23:00 до 08:00 по поясу браузера, из которого в последний раз сохраняли эту страницу \(Москва · UTC\+3\)\. Чтобы тихие часы не зависели от браузера, выберите часовой пояс панели в «Настройки → Внешний вид»\./,
      ),
    ).toBeInTheDocument();
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

  it('расширенное оформление: выключено по умолчанию; образец можно прислать до сохранения, потом включить', async () => {
    renderPage(NotificationsPage, '/settings/notifications');
    const user = userEvent.setup();
    const toggle = await screen.findByRole('switch', { name: 'Расширенное оформление' });
    expect(toggle).not.toBeChecked();
    // Подсказка честно говорит, что старое приложение такое сообщение не покажет, и как проверить.
    expect(
      screen.getByText(/в старом вместо сообщения будет надпись «не поддерживается»/),
    ).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Добавить чат' }));
    await user.type(
      screen.getByRole('textbox', { name: 'Ссылка на чат Telegram' }),
      `tgram://${TOKEN}/-1002946167407`,
    );
    await user.click(toggle);
    await user.click(screen.getByRole('button', { name: 'Отправить тестовое сообщение' }));
    expect(await screen.findByText(/Тест доставлен в расширенном оформлении/)).toBeInTheDocument();
    // Тест ушёл с несохранённым значением переключателя.
    expect(mockTelegram.lastTestRich).toBe(true);

    await user.click(screen.getByRole('button', { name: 'Сохранить' }));
    await waitFor(() => expect(mockTelegram.settings.delivery.rich).toBe(true));
  });

  it('прокси: необязательный, сохраняется и показывается маской; маску отправить нельзя', async () => {
    renderPage(NotificationsPage, '/settings/notifications');
    const user = userEvent.setup();
    const field = await screen.findByLabelText(/Прокси/);
    await user.type(field, 'socks5://u:s3cret@10.0.0.5:1080');
    await user.click(screen.getByRole('button', { name: 'Сохранить' }));
    await waitFor(() => expect(mockTelegram.settings.proxy).toBe('socks5://u:***@10.0.0.5:1080'));
    expect(await screen.findByDisplayValue('socks5://u:***@10.0.0.5:1080')).toBeInTheDocument();
    await user.type(screen.getByLabelText(/Прокси/), '0');
    expect(screen.getByText(/введите целиком/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Сохранить' })).toBeDisabled();
  });
});
