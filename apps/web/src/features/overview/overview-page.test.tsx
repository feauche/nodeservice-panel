import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { ServerModalHost } from '@/features/servers/server-modal-host';
import { useServerModalStore } from '@/features/servers/server-modal-store';
import { resetMockState } from '@/test/msw/handlers';
import { mockIncidents } from '@/test/msw/incidents-mock';
import { mockMetrics } from '@/test/msw/metrics-mock';
import { mockRemnawave } from '@/test/msw/remnawave-mock';
import { mockServers, seedServers } from '@/test/msw/servers-mock';
import { renderPage } from '@/test/render';
import { formatMbps, formatTraffic } from './overview-format';
import { OverviewPage } from './overview-page';

describe('OverviewPage (по демо)', () => {
  beforeEach(() => {
    resetMockState({ authenticated: true });
    seedServers();
  });

  it('полоса здоровья: счётчики и процент из состояния серверов', async () => {
    renderPage(OverviewPage, '/');
    expect(await screen.findByText('1 в норме')).toBeInTheDocument();
    expect(screen.getByText('1 офлайн')).toBeInTheDocument();
    expect(screen.getByText('50%')).toBeInTheDocument();
  });

  it('«Требует внимания»: сервер открывается карточкой поверх обзора, без перехода в «Серверы»', async () => {
    useServerModalStore.getState().close();
    const Page = () => (
      <>
        <OverviewPage />
        <ServerModalHost />
      </>
    );
    const { router } = renderPage(Page, '/', ['/servers']);
    const user = userEvent.setup();
    // nl-ams-02 в моках недоступен по SSH — строка в «Требует внимания»
    await user.click(await screen.findByRole('button', { name: /nl-ams-02/ }));
    expect(await screen.findByRole('dialog', { name: 'nl-ams-02' })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/');
  });

  it('KPI-плитки: серверы, CPU, трафик, соединения — со спарклайнами', async () => {
    renderPage(OverviewPage, '/');
    expect(await screen.findByText('Серверов в норме')).toBeInTheDocument();
    expect(screen.getByText('Средний CPU')).toBeInTheDocument();
    expect(screen.getByText('Трафик сейчас')).toBeInTheDocument();
    expect(screen.getByText(/Приём · отдача/)).toBeInTheDocument();
    expect(screen.getByText('Соединений сейчас')).toBeInTheDocument();
    expect((await screen.findAllByTestId('sparkline')).length).toBeGreaterThanOrEqual(3);
    expect(await screen.findByTestId('areaspark')).toBeInTheDocument();
  });

  it('всё спокойно: центрированное пустое состояние, когда проблем нет', async () => {
    mockIncidents.items = [];
    // Тот же классификатор, что на «Серверах»: спокойно только когда SSH в порядке и агент в сети.
    mockServers.items = mockServers.items.map((s) => ({ ...s, sshOk: true, agentStatus: 'online' as const }));
    renderPage(OverviewPage, '/');
    expect(await screen.findByText('Всё спокойно')).toBeInTheDocument();
    expect(screen.getByText('Проблем на серверах не найдено.')).toBeInTheDocument();
  });

  it('трафик без данных: центрированное «Пока нет данных» вместо тире', async () => {
    mockMetrics.hasData = false;
    renderPage(OverviewPage, '/');
    expect(await screen.findByText('Пока нет данных')).toBeInTheDocument();
    expect(screen.getByText('Трафик появится, когда агент выйдет на связь.')).toBeInTheDocument();
  });

  it('«Требует внимания»: сервер с недоступным SSH в списке с причиной и пилюлей', async () => {
    renderPage(OverviewPage, '/');
    const panel = (await screen.findByText('Требует внимания')).closest('section') as HTMLElement;
    expect(within(panel).getByText('nl-ams-02')).toBeInTheDocument();
    expect(within(panel).getByText('SSH недоступен')).toBeInTheDocument();
    expect(within(panel).getByText('Офлайн')).toBeInTheDocument();
  });

  it('последние события Журнала с ссылкой', async () => {
    renderPage(OverviewPage, '/');
    const panel = (await screen.findByText('Последние события')).closest('section') as HTMLElement;
    expect(within(panel).getByText('Журнал →')).toBeInTheDocument();
  });

  it('метрик нет (агент молчит): тире и подпись, спарклайнов нет', async () => {
    mockMetrics.hasData = false;
    renderPage(OverviewPage, '/');
    expect(await screen.findByText('Метрики появятся, когда агент выйдет на связь.')).toBeInTheDocument();
    expect(screen.queryAllByTestId('sparkline')).toHaveLength(0);
    expect(screen.queryByTestId('areaspark')).not.toBeInTheDocument();
  });

  it('баннер активных инцидентов ведёт в раздел «Инциденты» (R3 открыт)', async () => {
    renderPage(OverviewPage, '/', ['/incidents']);
    const banner = await screen.findByText(/активных/);
    expect(banner).toBeInTheDocument();
    expect(banner.closest('a')).toHaveAttribute('href', '/incidents');
  });

  it('«Требует внимания» согласован с карточками: агент не установлен — внимание, не норма', async () => {
    mockServers.items = mockServers.items.map((s) => ({ ...s, sshOk: true }));
    renderPage(OverviewPage, '/');
    const panel = (await screen.findByText('Требует внимания')).closest('section') as HTMLElement;
    expect(within(panel).getByText('nl-ams-02')).toBeInTheDocument();
    expect(within(panel).getByText('Агент не установлен')).toBeInTheDocument();
    expect(within(panel).getByText('Внимание')).toBeInTheDocument();
  });

  it('плитка Remnawave (B1): не показана, пока не подключено; появляется с цифрами и ведёт на страницу подключения', async () => {
    renderPage(OverviewPage, '/', ['/servers/remnawave']);
    await screen.findByText('1 в норме');
    expect(screen.queryByText(/Remnawave:/)).not.toBeInTheDocument();

    mockRemnawave.connected = true;
    mockRemnawave.domain = 'vpn-panel.example.com';
    mockRemnawave.stats = {
      users: { total: 870, active: 812, disabled: 14, limited: 3, expired: 41 },
      online: { now: 236, lastDay: 512, lastWeek: 640, never: 28 },
      nodesOnline: 4,
      nodesTotal: 5,
      trafficBytesLifetime: '20239053209600',
      panelVersion: '3.4.4',
      panelUptimeSec: 361_440,
    };
    const { router } = renderPage(OverviewPage, '/', ['/servers/remnawave']);
    const tile = await screen.findByText('Remnawave: 4 из 5 нод на связи');
    expect(
      screen.getByText(/^\d+ онлайн на нодах · 870 пользователей · 18\.4 ТБ трафика$/),
    ).toBeInTheDocument();
    const user = userEvent.setup();
    await user.click(tile);
    await waitFor(() => expect(router.state.location.pathname).toBe('/servers/remnawave'));
  });

  it('форматтеры трафика', () => {
    expect(formatMbps(1_000_000)).toBe('8.0');
    expect(formatTraffic(300_000_000)).toEqual({ value: '2.40', unit: 'Гбит/с' });
    expect(formatTraffic(2_000_000)).toEqual({ value: '16', unit: 'Мбит/с' });
    expect(formatTraffic(500_000)).toEqual({ value: '4.0', unit: 'Мбит/с' });
    expect(formatTraffic(null)).toEqual({ value: '—', unit: '' });
  });
});
