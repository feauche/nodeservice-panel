import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';

import { resetMockState } from '@/test/msw/handlers';
import { mockIncidents } from '@/test/msw/incidents-mock';
import { mockServers } from '@/test/msw/servers-mock';
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

  it('удаление: один инцидент из карточки и все решённые кнопкой на фильтре', async () => {
    renderPage(IncidentsPage, '/incidents');
    const user = userEvent.setup();
    await user.click(await screen.findByText('SSH недоступен · nl-ams-02'));
    await user.click(await screen.findByRole('button', { name: /^Удалить$/ }));
    await user.click(await screen.findByRole('button', { name: 'Удалить' }));
    await waitFor(() => expect(mockIncidents.items.some((i) => i.kind === 'ssh_down')).toBe(false));
    await waitFor(() => expect(screen.queryByText('SSH недоступен · nl-ams-02')).not.toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: /^Решённые/ }));
    await user.click(await screen.findByRole('button', { name: /Удалить решённые/ }));
    await user.click(await screen.findByRole('button', { name: 'Удалить' }));
    await waitFor(() => expect(mockIncidents.items.some((i) => i.status === 'resolved')).toBe(false));
    expect(await screen.findByText('Пока спокойно')).toBeInTheDocument();
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

  it('свежий инцидент: «ждём ещё N с — возможно, поднимется само», пока автопочинка выжидает', async () => {
    const [base] = mockIncidents.items;
    if (!base) throw new Error('нет мок-инцидента');
    mockIncidents.items = [
      {
        ...base,
        id: '7d9a2b1c-3e4f-4a5b-8c6d-9e0f1a2b3c4d',
        kind: 'node_down',
        title: 'Контейнер ноды не запущен · nl-ams-02',
        openedAt: new Date(Date.now() - 10_000).toISOString(),
        attempts: [],
        proposal: null,
      },
    ];
    renderPage(IncidentsPage, '/incidents');
    expect(await screen.findByText(/ждём ещё \d+ с — возможно, поднимется само/)).toBeInTheDocument();
  });

  it('закрытие «Контейнер ноды не запущен» с галочкой выключает слежение за нодой на сервере', async () => {
    const [base] = mockIncidents.items;
    if (!base) throw new Error('нет мок-инцидента');
    mockIncidents.items = [
      {
        ...base,
        id: '7d9a2b1c-3e4f-4a5b-8c6d-9e0f1a2b3c4e',
        kind: 'node_down',
        title: 'Контейнер ноды не запущен · nl-ams-02',
        openedAt: new Date(Date.now() - 600_000).toISOString(),
        attempts: [],
        proposal: null,
      },
    ];
    renderPage(IncidentsPage, '/incidents');
    const user = userEvent.setup();
    await user.click(await screen.findByText('Контейнер ноды не запущен · nl-ams-02'));
    await user.click(await screen.findByRole('button', { name: /Закрыть вручную/ }));
    await user.click(await screen.findByRole('checkbox', { name: /Больше не следить/ }));
    await user.click(await screen.findByRole('button', { name: 'Закрыть' }));
    await waitFor(() => expect(mockServers.items.find((s) => s.id === base.serverId)?.nodeWatch).toBe('off'));
    expect(mockIncidents.items[0]?.status).toBe('resolved');
  });

  it('пустое состояние, когда инцидентов нет', async () => {
    mockIncidents.items = [];
    renderPage(IncidentsPage, '/incidents');
    expect(await screen.findByText('Пока спокойно')).toBeInTheDocument();
  });
});
