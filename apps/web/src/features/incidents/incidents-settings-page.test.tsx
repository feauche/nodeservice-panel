import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { mockMonitoring, resetMockState } from '@/test/msw/handlers';
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
});
