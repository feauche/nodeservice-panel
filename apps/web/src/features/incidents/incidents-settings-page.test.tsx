import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';

import { resetMockState } from '@/test/msw/handlers';
import { mockIncidents } from '@/test/msw/incidents-mock';
import { renderPage } from '@/test/render';
import { IncidentsSettingsPage } from './incidents-settings-page';

describe('IncidentsSettingsPage', () => {
  beforeEach(() => resetMockState({ authenticated: true }));

  it('значения из настроек, «По умолчанию» задизейблена на дефолтах', async () => {
    renderPage(IncidentsSettingsPage, '/settings/incidents');
    expect(await screen.findByLabelText('Порог CPU')).toHaveValue('90');
    expect(screen.getByLabelText('Время реакции')).toHaveValue('5');
    expect(screen.getByRole('button', { name: /По умолчанию/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Сохранить' })).toBeDisabled();
  });

  it('сохранение изменённого порога уходит в API', async () => {
    renderPage(IncidentsSettingsPage, '/settings/incidents');
    const user = userEvent.setup();
    const cpu = await screen.findByLabelText('Порог CPU');
    await user.clear(cpu);
    await user.type(cpu, '80');
    await user.click(screen.getByRole('button', { name: 'Сохранить' }));
    await waitFor(() => expect(mockIncidents.settings.cpuPct).toBe(80));
  });

  it('невалидный порог — ошибка у поля, запрос не уходит', async () => {
    renderPage(IncidentsSettingsPage, '/settings/incidents');
    const user = userEvent.setup();
    const cpu = await screen.findByLabelText('Порог CPU');
    await user.clear(cpu);
    await user.type(cpu, '40');
    await user.click(screen.getByRole('button', { name: 'Сохранить' }));
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(mockIncidents.settings.cpuPct).toBe(90);
  });
});
