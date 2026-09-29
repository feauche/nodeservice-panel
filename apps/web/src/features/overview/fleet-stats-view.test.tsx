import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';

import { useServerModalStore } from '@/features/servers/server-modal-store';
import { mockFleetStats } from '@/test/msw/fleet-stats-mock';
import { resetMockState } from '@/test/msw/handlers';
import { mockServers } from '@/test/msw/servers-mock';
import { renderPage } from '@/test/render';
import { FleetStatsView } from './fleet-stats-view';

describe('Обзор → Статистика', () => {
  beforeEach(() => {
    resetMockState({ authenticated: true });
    localStorage.clear();
    useServerModalStore.getState().close();
  });

  it('итоги за 30 дней, период переключается и запоминается, строка сервера открывает окно', async () => {
    renderPage(FleetStatsView, '/');
    expect(await screen.findByTestId('fs-traffic')).toHaveTextContent(/Трафик за 30 дней.*ТБ/);
    expect(screen.getByTestId('fs-peak')).toHaveTextContent('Гбит/с');
    expect(screen.getByTestId('fs-availability')).toHaveTextContent('99,79');
    expect(screen.getByTestId('fs-cost')).toHaveTextContent('за ТБ');
    const user = userEvent.setup();
    await user.click(screen.getByRole('radio', { name: 'Сутки' }));
    await waitFor(() => expect(screen.getByTestId('fs-traffic')).toHaveTextContent('Трафик за сутки'));
    expect(localStorage.getItem('ns-fleet-stats-period')).toBe('day');
    const first = mockServers.items[0];
    if (!first) throw new Error('seed');
    await user.click(within(screen.getByTestId('fs-servers')).getByText(first.name));
    expect(useServerModalStore.getState().serverId).toBe(first.id);
  });

  it('хранилище метрик не ответило, онлайн ещё не записан — честные пояснения', async () => {
    mockFleetStats.vmOk = false;
    mockFleetStats.onlineRecorded = false;
    renderPage(FleetStatsView, '/');
    expect(await screen.findByText(/Хранилище метрик не ответило/)).toBeInTheDocument();
    expect(screen.getByTestId('fs-traffic')).toHaveTextContent('Нет данных');
    expect(screen.getByText(/записывает онлайн каждой ноды раз в минуту/)).toBeInTheDocument();
  });
});
