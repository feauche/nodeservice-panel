import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import { beforeEach, describe, expect, it } from 'vitest';

import { resetMockState } from '@/test/msw/handlers';
import { mockIncidents } from '@/test/msw/incidents-mock';
import { server } from '@/test/msw/server';
import { renderPage } from '@/test/render';
import { IncidentsSettingsPage } from './incidents-settings-page';

describe('IncidentsSettingsPage', () => {
  beforeEach(() => resetMockState({ authenticated: true }));

  it('значения из настроек, «По умолчанию» задизейблена на дефолтах', async () => {
    renderPage(IncidentsSettingsPage, '/settings/incidents');
    expect(await screen.findByLabelText('Порог процессора')).toHaveValue('90');
    expect(screen.getByLabelText('Время реакции')).toHaveValue('5');
    expect(screen.getByRole('button', { name: /По умолчанию/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Сохранить' })).toBeDisabled();
  });

  it('сохранение изменённого порога уходит в API', async () => {
    renderPage(IncidentsSettingsPage, '/settings/incidents');
    const user = userEvent.setup();
    const cpu = await screen.findByLabelText('Порог процессора');
    await user.clear(cpu);
    await user.type(cpu, '80');
    await user.click(screen.getByRole('button', { name: 'Сохранить' }));
    await waitFor(() => expect(mockIncidents.settings.cpuPct).toBe(80));
  });

  it('невалидный порог — ошибка у поля, запрос не уходит', async () => {
    renderPage(IncidentsSettingsPage, '/settings/incidents');
    const user = userEvent.setup();
    const cpu = await screen.findByLabelText('Порог процессора');
    await user.clear(cpu);
    await user.type(cpu, '40');
    await user.click(screen.getByRole('button', { name: 'Сохранить' }));
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(mockIncidents.settings.cpuPct).toBe(90);
  });

  it('сохранение отправляет только поля раздела: режимы по сигналам и пауза в запрос не попадают', async () => {
    let sent: Record<string, unknown> | null = null;
    server.use(
      http.put('/api/settings/incidents', async ({ request }) => {
        sent = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({ ...mockIncidents.settings, ...sent });
      }),
    );
    renderPage(IncidentsSettingsPage, '/settings/incidents');
    const user = userEvent.setup();
    const cpu = await screen.findByLabelText('Порог процессора');
    await user.clear(cpu);
    await user.type(cpu, '95');
    await user.click(screen.getByRole('button', { name: 'Сохранить' }));
    await waitFor(() => expect(sent).not.toBeNull());
    expect(sent).toEqual({
      forDurationMinutes: 5,
      cpuPct: 95,
      memPct: 90,
      diskPct: 85,
      autofixEnabled: false,
      autofixCooldownMinutes: 30,
    });
  });

  it('режимы автопочинки и пауза переживают «Сохранить» и «По умолчанию»', async () => {
    // На странице «Автопочинка» выбраны режимы и стоит пауза на время работ.
    const pausedUntil = new Date(Date.now() + 2 * 3_600_000).toISOString();
    mockIncidents.settings = {
      ...mockIncidents.settings,
      policy: { node_down: 'auto', cpu_high: 'watch' },
      pausedUntil,
    };
    renderPage(IncidentsSettingsPage, '/settings/incidents');
    const user = userEvent.setup();
    const cpu = await screen.findByLabelText('Порог процессора');
    await user.clear(cpu);
    await user.type(cpu, '95');
    await user.click(screen.getByRole('button', { name: 'Сохранить' }));
    await waitFor(() => expect(mockIncidents.settings.cpuPct).toBe(95));
    expect(mockIncidents.settings.policy).toEqual({ node_down: 'auto', cpu_high: 'watch' });
    expect(mockIncidents.settings.pausedUntil).toBe(pausedUntil);

    await user.click(screen.getByRole('button', { name: /По умолчанию/ }));
    await waitFor(() => expect(mockIncidents.settings.cpuPct).toBe(90));
    expect(mockIncidents.settings.policy).toEqual({ node_down: 'auto', cpu_high: 'watch' });
    expect(mockIncidents.settings.pausedUntil).toBe(pausedUntil);
  });
});
