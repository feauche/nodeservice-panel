import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';

import { resetMockState } from '@/test/msw/handlers';
import { mockIncidents } from '@/test/msw/incidents-mock';
import { renderPage } from '@/test/render';
import { IncidentsPage } from './incidents-page';

describe('IncidentsPage', () => {
  beforeEach(() => resetMockState({ authenticated: true }));

  it('список инцидентов, строка-итог и фильтр «Решённые»', async () => {
    renderPage(IncidentsPage, '/incidents');
    expect(await screen.findByText('SSH недоступен · nl-ams-02')).toBeInTheDocument();
    expect(screen.getByText('Высокая нагрузка на CPU · de-fra-01')).toBeInTheDocument();
    // строка под заголовком: что ждёт подтверждения
    expect(screen.getByText(/Перезапустить контейнер ноды ждёт подтверждения/)).toBeInTheDocument();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /^Решённые/ }));
    await waitFor(() => expect(screen.queryByText('SSH недоступен · nl-ams-02')).not.toBeInTheDocument());
    expect(screen.getByText('Диск заполняется · de-fra-01')).toBeInTheDocument();
    expect(screen.getByText(/«освободить диск» помогло/i)).toBeInTheDocument();
  });

  it('раскрытие: хронология с уровнями, попытка с шагами и предложение «ждёт подтверждения»', async () => {
    renderPage(IncidentsPage, '/incidents');
    const user = userEvent.setup();
    await user.click(await screen.findByText('Высокая нагрузка на CPU · de-fra-01'));
    expect(await screen.findByText('Что происходило')).toBeInTheDocument();
    const timeline = screen.getByRole('list', { name: 'Хронология' });
    expect(within(timeline).getAllByText('T2').length).toBeGreaterThan(0);
    expect(within(timeline).getByText(/Предложено: Перезапустить контейнер ноды/)).toBeInTheDocument();
    const proposal = screen.getByTestId('proposal-block');
    expect(proposal).toHaveTextContent('Следующий шаг требует подтверждения');
    expect(proposal).toHaveTextContent('T2');
    expect(
      within(proposal).getByRole('button', { name: /Подтвердить: перезапустить контейнер ноды/ }),
    ).toBeInTheDocument();
  });

  it('Подтверждение запускает действие без пароля: шаги идут на месте, инцидент закрывается', async () => {
    renderPage(IncidentsPage, '/incidents');
    const user = userEvent.setup();
    await user.click(await screen.findByText('Высокая нагрузка на CPU · de-fra-01'));
    await user.click(
      await screen.findByRole('button', { name: /Подтвердить: перезапустить контейнер ноды/ }),
    );
    await waitFor(() =>
      expect(screen.getByTestId('attempt-block')).toHaveTextContent(
        'Попытка 1 · Перезапустить контейнер ноды',
      ),
    );
    await waitFor(
      () => expect(mockIncidents.items.find((i) => i.kind === 'cpu_high')?.status).toBe('resolved'),
      { timeout: 4000 },
    );
    await waitFor(() => expect(screen.getByTestId('attempt-block')).toHaveTextContent('помогло'), {
      timeout: 4000,
    });
    expect(screen.queryByTestId('proposal-block')).not.toBeInTheDocument();
  });

  it('T3 в предложении: команда, «Копировать», «Открыть терминал», без кнопки подтверждения', async () => {
    const cpu = mockIncidents.items.find((i) => i.kind === 'cpu_high');
    if (!cpu) throw new Error('seed');
    cpu.proposal = {
      action: 'reboot',
      level: 'T3',
      reason: 'контейнер не помог',
      proposedAt: new Date().toISOString(),
    };
    renderPage(IncidentsPage, '/incidents');
    const user = userEvent.setup();
    await user.click(await screen.findByText('Высокая нагрузка на CPU · de-fra-01'));
    const proposal = await screen.findByTestId('proposal-block');
    expect(proposal).toHaveTextContent('Следующий шаг только вручную');
    expect(within(proposal).getByRole('button', { name: 'Копировать команду' })).toBeInTheDocument();
    expect(await within(proposal).findByRole('button', { name: 'Открыть терминал' })).toBeInTheDocument();
    expect(within(proposal).queryByRole('button', { name: /^Подтвердить:/ })).not.toBeInTheDocument();
  });

  it('«Логи ноды» (T0): попытка «выполнено», вывод в карточке, предложение на месте', async () => {
    renderPage(IncidentsPage, '/incidents');
    const user = userEvent.setup();
    await user.click(await screen.findByText('Высокая нагрузка на CPU · de-fra-01'));
    await user.click(await screen.findByRole('button', { name: /Логи ноды/ }));
    await waitFor(
      () => expect(screen.getByTestId('attempt-block')).toHaveTextContent('Попытка 1 · Логи ноды'),
      {
        timeout: 4000,
      },
    );
    await waitFor(() => expect(screen.getByTestId('attempt-block')).toHaveTextContent('выполнено'), {
      timeout: 4000,
    });
    expect(screen.getByTestId('attempt-block')).toHaveTextContent('xray started');
    expect(screen.getByTestId('proposal-block')).toBeInTheDocument();
    expect(mockIncidents.items.find((i) => i.kind === 'cpu_high')?.status).not.toBe('resolved');
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

  it('вкладка «Автопочинка»: карточки с уровнями, общий тумблер и тумблер T1 пишутся в настройки', async () => {
    renderPage(IncidentsPage, '/incidents');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Автопочинка' }));
    const cards = await screen.findAllByTestId('action-card');
    expect(cards.length).toBeGreaterThanOrEqual(8);
    const free = cards.find((c) => within(c).queryByText('Освободить диск'));
    if (!free) throw new Error('card');
    expect(free).toHaveTextContent('T1');
    expect(free).toHaveTextContent('Помогло 1 из 1');
    const node = cards.find((c) => within(c).queryByText('Перезапустить контейнер ноды'));
    expect(node).toHaveTextContent('Только с подтверждением');
    const reboot = cards.find((c) => within(c).queryByText('Перезагрузить сервер'));
    expect(reboot).toHaveTextContent('T3');
    expect(reboot).toHaveTextContent('Панель не выполняет');

    await user.click(screen.getByRole('switch', { name: 'Автопочинка' }));
    await waitFor(() => expect(mockIncidents.settings.autofixEnabled).toBe(true));
    await user.click(within(free).getByRole('switch', { name: 'Авто: Освободить диск' }));
    await waitFor(() => expect(mockIncidents.settings.actions.free_disk).toBe(true));
  });

  it('пустое состояние, когда инцидентов нет', async () => {
    mockIncidents.items = [];
    renderPage(IncidentsPage, '/incidents');
    expect(await screen.findByText('Пока спокойно')).toBeInTheDocument();
  });
});
