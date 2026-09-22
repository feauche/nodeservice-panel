import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';

import { resetMockState } from '@/test/msw/handlers';
import { mockIncidents } from '@/test/msw/incidents-mock';
import { renderPage } from '@/test/render';
import { IncidentsPage } from './incidents-page';

describe('IncidentsPage', () => {
  beforeEach(() => resetMockState({ authenticated: true }));

  it('список инцидентов и фильтр «Решённые»', async () => {
    renderPage(IncidentsPage, '/incidents');
    expect(await screen.findByText('SSH недоступен · nl-ams-02')).toBeInTheDocument();
    expect(screen.getByText('Высокая нагрузка на CPU · de-fra-01')).toBeInTheDocument();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Решённые' }));
    await waitFor(() => expect(screen.queryByText('SSH недоступен · nl-ams-02')).not.toBeInTheDocument());
    expect(screen.getByText('Диск заполняется · de-fra-01')).toBeInTheDocument();
  });

  it('раскрытие показывает таймлайн и блок автопочинки', async () => {
    renderPage(IncidentsPage, '/incidents');
    const user = userEvent.setup();
    await user.click(await screen.findByText('Высокая нагрузка на CPU · de-fra-01'));
    expect(await screen.findByText('Что происходило')).toBeInTheDocument();
    expect(screen.getByText('Автопочинка')).toBeInTheDocument();
    expect(screen.getByText('Перезапустить Xray')).toBeInTheDocument();
  });

  it('автопочинка применяет пресет: инцидент закрывается', async () => {
    renderPage(IncidentsPage, '/incidents');
    const user = userEvent.setup();
    await user.click(await screen.findByText('Высокая нагрузка на CPU · de-fra-01'));
    await user.click(await screen.findByRole('button', { name: 'Применить' }));
    await waitFor(() =>
      expect(mockIncidents.items.find((i) => i.kind === 'cpu_high')?.status).toBe('resolved'),
    );
  });

  it('ручное закрытие через подтверждение', async () => {
    renderPage(IncidentsPage, '/incidents');
    const user = userEvent.setup();
    await user.click(await screen.findByText('SSH недоступен · nl-ams-02'));
    await user.click(await screen.findByRole('button', { name: /Закрыть вручную/ }));
    await user.click(await screen.findByRole('button', { name: 'Закрыть' }));
    await waitFor(() =>
      expect(mockIncidents.items.find((i) => i.kind === 'ssh_down')?.status).toBe('resolved'),
    );
  });

  it('пустое состояние, когда инцидентов нет', async () => {
    mockIncidents.items = [];
    renderPage(IncidentsPage, '/incidents');
    expect(await screen.findByText('Пока спокойно')).toBeInTheDocument();
  });
});
