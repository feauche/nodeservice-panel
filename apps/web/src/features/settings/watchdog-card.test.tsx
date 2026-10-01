import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { Toaster } from '@/components/ui/sonner';
import { toast } from '@/lib/notify';
import { resetMockState } from '@/test/msw/handlers';
import { mockServers } from '@/test/msw/servers-mock';
import { mockTelegram } from '@/test/msw/telegram-mock';
import { renderPage } from '@/test/render';
import { NotificationsPage } from './notifications-page';

// Тосты рисует Toaster, а ему (и next-themes) нужен matchMedia, которого в jsdom нет.
window.matchMedia ??= ((query: string) => ({
  matches: false,
  media: query,
  onchange: null,
  addEventListener: () => {},
  removeEventListener: () => {},
  addListener: () => {},
  removeListener: () => {},
  dispatchEvent: () => false,
})) as unknown as typeof window.matchMedia;

const Page = () => (
  <>
    <NotificationsPage />
    <Toaster />
  </>
);

const CHAT = {
  id: 'tg-1',
  masked: 'tgram://***/-1002946167407',
  chatId: '-1002946167407',
  topic: null,
  botName: '@lumax_alert_bot',
  chatTitle: 'VPN-алерты',
  lastTest: null,
  lastDelivery: null,
};

const card = async () =>
  (await screen.findByRole('heading', { name: 'Сторож панели' })).closest('section') as HTMLElement;

describe('«Уведомления» → «Сторож панели»', () => {
  beforeEach(() => {
    resetMockState({ authenticated: true });
    toast.dismiss();
  });

  it('чатов нет — поставить нельзя, и сказано, что сделать', async () => {
    renderPage(Page, '/settings/notifications');
    const c = await card();
    expect(await within(c).findByText(/Сначала добавьте чат Telegram выше и сохраните/)).toBeInTheDocument();
    expect(within(c).getByRole('button', { name: 'Поставить сторожа' })).toBeDisabled();
  });

  it('пояснение честное: лучше зарубежный сервер (Telegram из России), что знает сторож; поле необязательное', async () => {
    mockTelegram.settings.destinations = [CHAT];
    renderPage(Page, '/settings/notifications');
    const c = await card();
    expect(within(c).getByText(/раз в минуту он проверяет панель/)).toBeInTheDocument();
    expect(
      await within(c).findByText(/Лучше зарубежный: из России Telegram может быть недоступен/),
    ).toBeInTheDocument();
    expect(
      within(c).getByText(/Сторож знает токен бота: он может только отправлять сообщения в ваш чат\./),
    ).toBeInTheDocument();
    expect(within(c).getByText('необязательно')).toBeInTheDocument();
  });

  it('выбрать сервер → «Поставить сторожа» → «поставлен на сервере X, дата»; проверить; убрать', async () => {
    mockTelegram.settings.destinations = [CHAT];
    renderPage(Page, '/settings/notifications');
    const user = userEvent.setup();
    const c = await card();
    await user.click(await within(c).findByRole('combobox', { name: 'Сервер для сторожа' }));
    await user.click(await screen.findByRole('option', { name: /de-fra-01/ }));
    await user.click(within(c).getByRole('button', { name: 'Поставить сторожа' }));
    expect(await within(c).findByText(/^На сервере «de-fra-01» с /)).toBeInTheDocument();
    expect(await screen.findByText(/Сторож поставлен на сервер «de-fra-01»/)).toBeInTheDocument();
    expect(mockTelegram.watchdog?.serverName).toBe('de-fra-01');

    await user.click(within(c).getByRole('button', { name: 'Проверить сторожа' }));
    expect(
      await screen.findByText(
        'Сторож на сервере «de-fra-01» на месте: тестовое сообщение отправлено, панель с этого сервера отвечает.',
      ),
    ).toBeInTheDocument();

    await user.click(within(c).getByRole('button', { name: 'Убрать' }));
    expect(await within(c).findByRole('button', { name: 'Поставить сторожа' })).toBeInTheDocument();
    expect(await screen.findByText('Сторож убран с сервера «de-fra-01».')).toBeInTheDocument();
    expect(mockTelegram.watchdog).toBeNull();
  });

  it('серверы из России — в конце списка, под своей подписью', async () => {
    mockTelegram.settings.destinations = [CHAT];
    const first = mockServers.items[0];
    if (first)
      mockServers.items.push({
        ...first,
        id: '0192c000-0000-7000-8000-00000000abcd',
        name: 'ru-msk-01',
        country: { ...first.country, code: 'RU' },
      });
    renderPage(Page, '/settings/notifications');
    const user = userEvent.setup();
    const c = await card();
    await user.click(await within(c).findByRole('combobox', { name: 'Сервер для сторожа' }));
    const names = (await screen.findAllByRole('option')).map((o) => o.textContent ?? '');
    expect(names.at(-1)).toMatch(/^ru-msk-01/);
    expect(screen.getByText('В России')).toBeInTheDocument();
    expect(screen.getByText('За рубежом')).toBeInTheDocument();
  });

  it('чаты поменялись после установки — «сторож пишет по-старому» и «Поставить заново»', async () => {
    mockTelegram.settings.destinations = [CHAT];
    renderPage(Page, '/settings/notifications');
    const user = userEvent.setup();
    const c = await card();
    await user.click(await within(c).findByRole('combobox', { name: 'Сервер для сторожа' }));
    await user.click(await screen.findByRole('option', { name: /de-fra-01/ }));
    await user.click(within(c).getByRole('button', { name: 'Поставить сторожа' }));
    await within(c).findByText(/^На сервере «de-fra-01» с /);
    // Добавили второй чат и сохранили страницу.
    await user.click(screen.getByRole('button', { name: 'Добавить чат' }));
    await user.type(
      screen.getByRole('textbox', { name: 'Ссылка на чат Telegram' }),
      'tgram://123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw/412345678',
    );
    await user.click(screen.getByRole('button', { name: 'Сохранить' }));
    expect(await within(c).findByText(/сторож пишет и проверяет по-старому/)).toBeInTheDocument();
    await user.click(within(c).getByRole('button', { name: 'Поставить заново' }));
    await waitFor(() => expect(mockTelegram.watchdog?.outdated).toBe(false));
    await waitFor(() => expect(within(c).queryByText(/по-старому/)).toBeNull());
  });

  it('в «Что присылать» — тумблер «Сбои самой панели» в группе «Сама панель», по умолчанию включён', async () => {
    renderPage(Page, '/settings/notifications');
    expect(await screen.findByText('Сама панель')).toBeInTheDocument();
    const toggle = screen.getByRole('switch', { name: /Сбои самой панели/ });
    expect(toggle).toBeChecked();
    expect(
      screen.getByText(/Панель перезапустилась после сбоя, метрики серверов перестали записываться/),
    ).toBeInTheDocument();
  });
});
