import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { mockMonitoring, resetMockState } from '@/test/msw/handlers';
import { mockChannelLimits, mockRemnawave } from '@/test/msw/remnawave-mock';
import { mockTelegram } from '@/test/msw/telegram-mock';
import { renderPage } from '@/test/render';
import { IncidentsSettingsPage } from './incidents-settings-page';

describe('Условия событий Remnawave', () => {
  beforeEach(() => resetMockState({ authenticated: true }));
  it('содержит падение онлайна, ресурсы и выбор Telegram без автопочинки', async () => {
    renderPage(IncidentsSettingsPage, '/settings/incidents');
    expect(await screen.findByLabelText('Падение онлайна')).toHaveValue('80');
    expect(screen.getByLabelText('Порог нагрузки на ядро')).toHaveValue('1,5');
    expect(await screen.findByText('События в Telegram')).toBeInTheDocument();
    expect(screen.queryByText('Автопочинка')).not.toBeInTheDocument();
    expect(screen.queryByText('Порог диска')).not.toBeInTheDocument();
  });
  it('меняет порог без сброса интервала проверок', async () => {
    renderPage(IncidentsSettingsPage, '/settings/incidents');
    const user = userEvent.setup();
    // Порог нагрузки на ядро — дробный: с запятой в поле, числом на сервере.
    const f = await screen.findByLabelText('Порог нагрузки на ядро');
    expect(f).toHaveValue('1,5');
    await user.clear(f);
    await user.type(f, '2,5');
    await user.click(screen.getByRole('button', { name: 'Сохранить' }));
    await waitFor(() => expect(mockMonitoring.value.loadPerCore).toBe(2.5));
    expect(mockMonitoring.value.checkHostHours).toBe(24);
  });
  it('виды уведомлений сохраняются общей полосой «Сохранить» раздела, своей кнопки у карточки нет', async () => {
    renderPage(IncidentsSettingsPage, '/settings/incidents');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('switch', { name: 'Память на пределе' }));
    expect(screen.queryByRole('button', { name: 'Сохранить уведомления' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Сохранить' }));
    await waitFor(() => expect(mockTelegram.settings.kinds.mem_high).toBe(false));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Сохранить' })).toBeNull());
  });
  it('канал: по умолчанию выключен; какие ноды проверяются (только с «Лимитом канала»); порог сохраняется', async () => {
    const node = (uuid: string, name: string) =>
      ({ uuid, name, isDisabled: false, isConnected: true }) as (typeof mockRemnawave.nodes)[number];
    Object.assign(mockRemnawave, {
      connected: true,
      nodes: [
        node('11111111-1111-4111-8111-111111111111', 'Германия - 1'),
        node('22222222-2222-4222-8222-222222222222', 'Польша - 1'),
      ],
    });
    mockChannelLimits.add('11111111-1111-4111-8111-111111111111');
    renderPage(IncidentsSettingsPage, '/settings/incidents');
    const user = userEvent.setup();
    const toggle = await screen.findByRole('switch', { name: 'Следить за каналом' });
    expect(toggle).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByLabelText('Порог канала')).toHaveValue('90');
    expect(await screen.findByText('1 из 2 нод')).toBeVisible();
    expect(screen.getByText(/Без лимита: Польша - 1\./)).toBeVisible();
    expect(screen.getByRole('switch', { name: 'Канал перегружен' })).toBeInTheDocument();
    await user.click(toggle);
    const f = screen.getByLabelText('Порог канала');
    await user.clear(f);
    await user.type(f, '85');
    await user.click(screen.getByRole('button', { name: 'Сохранить' }));
    await waitFor(() =>
      expect(mockMonitoring.value).toMatchObject({ channelEnabled: true, channelPercent: 85 }),
    );
  });
});
