import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { mockMonitoring, resetMockState } from '@/test/msw/handlers';
import { renderPage } from '@/test/render';
import { NodeMonitoringPage } from './node-monitoring-page';

describe('Мониторинг вместо SSH и агентов', () => {
  beforeEach(() => resetMockState({ authenticated: true }));
  it('показывает Remnawave и Check-Host с ежедневным интервалом и fallback', async () => {
    renderPage(NodeMonitoringPage, '/settings/monitoring');
    // Быстро по умолчанию (0.94.0): опрос раз в 15 секунд.
    expect(await screen.findByLabelText('Частота опроса')).toHaveValue('15');
    expect(screen.getByLabelText('Период проверки каждого IP')).toHaveValue('24');
    expect(screen.getByLabelText('TCP-порт')).toHaveValue('5492');
    expect(screen.getByText(/если недоступен — проверяем 22/)).toBeInTheDocument();
    expect(screen.queryByText('Метрики агента')).not.toBeInTheDocument();
  });
  it('сохраняет только поля проверок, сохраняя пороги событий', async () => {
    renderPage(NodeMonitoringPage, '/settings/monitoring');
    mockMonitoring.value.loadPerCore = 2;
    const user = userEvent.setup();
    const f = await screen.findByLabelText('Частота опроса');
    await user.clear(f);
    await user.type(f, '90');
    await user.click(screen.getByRole('button', { name: 'Сохранить' }));
    await waitFor(() => expect(mockMonitoring.value.pollSeconds).toBe(90));
    expect(mockMonitoring.value.loadPerCore).toBe(2);
  });
  it('после ошибки диапазона можно исправить поле и сохранить', async () => {
    renderPage(NodeMonitoringPage, '/settings/monitoring');
    const user = userEvent.setup();
    const f = await screen.findByLabelText('Частота опроса');
    await user.clear(f);
    await user.type(f, '1');
    await user.click(screen.getByRole('button', { name: 'Сохранить' }));
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(mockMonitoring.value.pollSeconds).toBe(15);
    await user.clear(f);
    await user.type(f, '120');
    await user.click(screen.getByRole('button', { name: 'Сохранить' }));
    await waitFor(() => expect(mockMonitoring.value.pollSeconds).toBe(120));
  });
});
