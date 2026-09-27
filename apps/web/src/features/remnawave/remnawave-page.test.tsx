import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';

import { Toaster } from '@/components/ui/sonner';
import { resetMockState } from '@/test/msw/handlers';
import { mockRemnawave } from '@/test/msw/remnawave-mock';
import { renderPage } from '@/test/render';
import { RemnawavePage } from './remnawave-page';

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

function Page() {
  return (
    <>
      <RemnawavePage />
      <Toaster />
    </>
  );
}

const fill = async (user: ReturnType<typeof userEvent.setup>, domain: string, key: string) => {
  await user.type(screen.getByLabelText('Домен панели'), domain);
  await user.type(screen.getByLabelText('Ключ API'), key);
};

describe('RemnawavePage', () => {
  beforeEach(() => {
    resetMockState({ authenticated: true });
  });

  it('не подключено: форма с двумя полями, кнопка выключена без ввода', async () => {
    renderPage(Page, '/servers/remnawave');
    expect(await screen.findByRole('heading', { name: 'Подключение' })).toBeInTheDocument();
    expect(screen.getByLabelText('Домен панели')).toHaveValue('');
    const btn = screen.getByRole('button', { name: 'Проверить и сохранить' });
    expect(btn).toBeDisabled();
  });

  it('успешное подключение: сводка, ноды и сертификат появляются, ключ не хранится в поле', async () => {
    renderPage(Page, '/servers/remnawave');
    await screen.findByRole('heading', { name: 'Подключение' });
    const user = userEvent.setup();
    await fill(user, 'vpn-panel.example.com', 'rw_pat_good');
    await user.click(screen.getByRole('button', { name: 'Проверить и сохранить' }));

    expect(await screen.findByRole('heading', { name: 'Подключено' })).toBeInTheDocument();
    expect(screen.getByText('vpn-panel.example.com')).toBeInTheDocument();
    expect(screen.getByText('870')).toBeInTheDocument(); // пользователей
    expect(screen.getByText('236')).toBeInTheDocument(); // онлайн сейчас
    expect(screen.getByText('bridge')).toBeInTheDocument();
    expect(screen.getByText('exit-nl')).toBeInTheDocument();
    expect(screen.getByText('Node did not respond in time')).toBeInTheDocument();
    expect(screen.getByText('Сертификат в порядке')).toBeInTheDocument();
    expect(screen.queryByLabelText('Домен панели')).not.toBeInTheDocument();
    expect(await screen.findByText('Remnawave подключена.')).toBeInTheDocument();
  });

  it('ошибка домена (502) и ошибка токена (400): текст с сервера, форма остаётся', async () => {
    renderPage(Page, '/servers/remnawave');
    await screen.findByRole('heading', { name: 'Подключение' });
    const user = userEvent.setup();
    await fill(user, 'unreachable.example.com', 'rw_pat_good');
    await user.click(screen.getByRole('button', { name: 'Проверить и сохранить' }));
    expect(
      await screen.findByText(/Remnawave \(https:\/\/unreachable\.example\.com\) не отвечает/),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('Домен панели')).toBeInTheDocument();

    await user.clear(screen.getByLabelText('Домен панели'));
    await user.clear(screen.getByLabelText('Ключ API'));
    await fill(user, 'vpn-panel.example.com', 'rw_pat_bad');
    await user.click(screen.getByRole('button', { name: 'Проверить и сохранить' }));
    expect(await screen.findByText(/токен неверный, отозван или просрочен/)).toBeInTheDocument();
  });

  it('обновить: свежая проверка перечитывает данные', async () => {
    renderPage(Page, '/servers/remnawave');
    await screen.findByRole('heading', { name: 'Подключение' });
    const user = userEvent.setup();
    await fill(user, 'vpn-panel.example.com', 'rw_pat_good');
    await user.click(screen.getByRole('button', { name: 'Проверить и сохранить' }));
    await screen.findByRole('heading', { name: 'Подключено' });

    await user.click(screen.getByRole('button', { name: 'Обновить' }));
    expect(await screen.findByText('Данные Remnawave обновлены.')).toBeInTheDocument();
  });

  it('недоступна между проверками: прежние данные остаются видны, ошибка показана честно', async () => {
    mockRemnawave.connected = true;
    mockRemnawave.domain = 'vpn-panel.example.com';
    mockRemnawave.checkedAt = '2026-09-27T10:00:00.000Z';
    mockRemnawave.error = 'таймаут подключения';
    mockRemnawave.stats = {
      users: { total: 870, active: 812, disabled: 14, limited: 3, expired: 41 },
      online: { now: 236, lastDay: 512, lastWeek: 640, never: 28 },
      nodesOnline: 4,
      nodesTotal: 5,
      trafficBytesLifetime: '20239053209600',
      panelVersion: '3.4.4',
      panelUptimeSec: 361_440,
    };
    mockRemnawave.nodes = [];
    mockRemnawave.cert = null;
    renderPage(Page, '/servers/remnawave');
    expect(await screen.findByText(/Сейчас недоступна: таймаут подключения/)).toBeInTheDocument();
    expect(screen.getByText('870')).toBeInTheDocument();
  });

  it('отключить: подтверждение, после — форма подключения снова', async () => {
    renderPage(Page, '/servers/remnawave');
    await screen.findByRole('heading', { name: 'Подключение' });
    const user = userEvent.setup();
    await fill(user, 'vpn-panel.example.com', 'rw_pat_good');
    await user.click(screen.getByRole('button', { name: 'Проверить и сохранить' }));
    await screen.findByRole('heading', { name: 'Подключено' });

    await user.click(screen.getByRole('button', { name: 'Отключить' }));
    const dialog = await screen.findByRole('alertdialog');
    await user.click(within(dialog).getByRole('button', { name: 'Да, отключить' }));
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Подключение' })).toBeInTheDocument());
    expect(await screen.findByText('Remnawave отключена.')).toBeInTheDocument();
  });
});
