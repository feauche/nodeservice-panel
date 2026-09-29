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
    // Онлайн — сумма по нодам (42 + нет данных), подписки в сети — подписью.
    expect(screen.getByText('подписок в сети 236')).toBeInTheDocument();
    expect(screen.getByText('bridge')).toBeInTheDocument();
    expect(screen.getByText('exit-nl')).toBeInTheDocument();
    expect(screen.getByText('Node did not respond in time')).toBeInTheDocument();
    expect(screen.getByTestId('rw-cert')).toHaveTextContent(/^Сертификат до \d+ нояб? · \d+ дн/);
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

  it('лимит трафика 0 у Remnawave — это «без лимита», «из 0 Б» не показываем', async () => {
    mockRemnawave.connected = true;
    mockRemnawave.domain = 'vpn-panel.example.com';
    mockRemnawave.checkedAt = '2026-09-27T10:00:00.000Z';
    mockRemnawave.error = null;
    mockRemnawave.stats = {
      users: { total: 870, active: 812, disabled: 14, limited: 3, expired: 41 },
      online: { now: 236, lastDay: 512, lastWeek: 640, never: 28 },
      nodesOnline: 1,
      nodesTotal: 1,
      trafficBytesLifetime: '20239053209600',
      panelVersion: '3.4.4',
      panelUptimeSec: 361_440,
    };
    mockRemnawave.nodes = [
      {
        uuid: '0192f200-0000-7000-8000-000000000009',
        name: 'unlimited-node',
        address: '203.0.113.200',
        countryCode: 'DE',
        isConnected: true,
        isDisabled: false,
        isConnecting: false,
        lastStatusMessage: null,
        usersOnline: 10,
        trafficUsedBytes: 1_771_302_247_621,
        trafficLimitBytes: 0,
      },
    ];
    mockRemnawave.cert = null;
    renderPage(Page, '/servers/remnawave');
    await screen.findByText('unlimited-node');
    expect(screen.queryByText(/из 0 Б/)).not.toBeInTheDocument();
  });

  it('«Добавить в NodeService»: только у несовпавшей ноды, окно открывается с готовыми, но редактируемыми полями', async () => {
    renderPage(Page, '/servers/remnawave');
    await screen.findByRole('heading', { name: 'Подключение' });
    const user = userEvent.setup();
    await fill(user, 'vpn-panel.example.com', 'rw_pat_good');
    await user.click(screen.getByRole('button', { name: 'Проверить и сохранить' }));
    await screen.findByRole('heading', { name: 'Подключено' });

    const bridgeRow = screen.getByText('bridge').closest('li');
    expect(bridgeRow).not.toBeNull();
    expect(
      within(bridgeRow as HTMLElement).queryByRole('button', { name: /Добавить в NodeService/ }),
    ).not.toBeInTheDocument();

    const exitRow = screen.getByText('exit-nl').closest('li');
    expect(exitRow).not.toBeNull();
    const addButton = within(exitRow as HTMLElement).getByRole('button', { name: /Добавить в NodeService/ });
    await user.click(addButton);

    expect(await screen.findByRole('heading', { name: 'Добавить сервер' })).toBeInTheDocument();
    const nameField = screen.getByLabelText('Название') as HTMLInputElement;
    const hostField = screen.getByLabelText('IP или домен') as HTMLInputElement;
    expect(nameField).toHaveValue('exit-nl');
    expect(hostField).toHaveValue('198.51.100.99');

    // Поля предзаполнены, но не заблокированы — можно поправить и то, и другое.
    expect(nameField).not.toBeDisabled();
    expect(hostField).not.toBeDisabled();
    await user.clear(nameField);
    await user.type(nameField, 'exit-nl-custom');
    expect(nameField).toHaveValue('exit-nl-custom');
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
