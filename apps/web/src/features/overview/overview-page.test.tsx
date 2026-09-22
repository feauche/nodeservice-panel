import { screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';

import { resetMockState } from '@/test/msw/handlers';
import { mockMetrics } from '@/test/msw/metrics-mock';
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

  it('KPI-плитки: серверы, CPU, трафик, соединения — со спарклайнами', async () => {
    renderPage(OverviewPage, '/');
    expect(await screen.findByText('Серверов в норме')).toBeInTheDocument();
    expect(screen.getByText('Средний CPU')).toBeInTheDocument();
    expect(screen.getByText('Трафик сейчас')).toBeInTheDocument();
    expect(screen.getByText(/приём · отдача/)).toBeInTheDocument();
    expect(screen.getByText('Соединений сейчас')).toBeInTheDocument();
    expect((await screen.findAllByTestId('sparkline')).length).toBeGreaterThanOrEqual(3);
    expect(await screen.findByTestId('areaspark')).toBeInTheDocument();
  });

  it('всё спокойно: центрированное пустое состояние, когда проблем нет', async () => {
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
    expect(within(panel).getByText('офлайн')).toBeInTheDocument();
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

  it('баннер активных инцидентов виден, но без ссылки, пока раздел «Инциденты» закрыт', async () => {
    renderPage(OverviewPage, '/');
    const banner = await screen.findByText(/активных/);
    expect(banner).toBeInTheDocument();
    expect(banner.closest('a')).toBeNull();
    expect(screen.queryByText('Открыть →')).not.toBeInTheDocument();
  });

  it('«Требует внимания» согласован с карточками: агент не установлен — внимание, не норма', async () => {
    mockServers.items = mockServers.items.map((s) => ({ ...s, sshOk: true }));
    renderPage(OverviewPage, '/');
    const panel = (await screen.findByText('Требует внимания')).closest('section') as HTMLElement;
    expect(within(panel).getByText('nl-ams-02')).toBeInTheDocument();
    expect(within(panel).getByText('Агент не установлен')).toBeInTheDocument();
    expect(within(panel).getByText('внимание')).toBeInTheDocument();
  });

  it('форматтеры трафика', () => {
    expect(formatMbps(1_000_000)).toBe('8.0');
    expect(formatTraffic(300_000_000)).toEqual({ value: '2.40', unit: 'Гбит/с' });
    expect(formatTraffic(2_000_000)).toEqual({ value: '16', unit: 'Мбит/с' });
    expect(formatTraffic(500_000)).toEqual({ value: '4.0', unit: 'Мбит/с' });
    expect(formatTraffic(null)).toEqual({ value: '—', unit: '' });
  });
});
