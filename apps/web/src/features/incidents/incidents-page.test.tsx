import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';

import { resetMockState } from '@/test/msw/handlers';
import { mockIncidents } from '@/test/msw/incidents-mock';
import { renderPage } from '@/test/render';
import { IncidentsPage } from './incidents-page';

const openId = () => mockIncidents.items.find((i) => i.kind === 'cpu_high')?.id ?? '';

describe('IncidentsPage', () => {
  beforeEach(() => resetMockState({ authenticated: true }));

  it('реестр: итог за 7 дней, группы по дням, строка одним предложением', async () => {
    renderPage(IncidentsPage, '/incidents', ['/incidents/$id', '/incidents/autofix']);
    const rows = await screen.findAllByTestId('incident-row');
    expect(rows.length).toBeGreaterThanOrEqual(4);
    // итог за 7 дней
    const stats = screen.getByTestId('incidents-stats');
    expect(stats).toHaveTextContent('сбоев за 7 дней');
    expect(stats).toHaveTextContent('починила панель');
    expect(stats).toHaveTextContent('прошли сами');
    // группа «Сейчас» для открытых
    expect(screen.getByRole('region', { name: 'Сейчас' })).toBeInTheDocument();
    // предложение читается предложением с заглавной
    expect(screen.getByText(/Ждёт подтверждения: перезапустить контейнер ноды/)).toBeInTheDocument();
    // решённый: «Помогло с первой попытки»
    expect(screen.getByText(/Помогло с первой попытки: освободить диск, автоматически/)).toBeInTheDocument();
  });

  it('решённые: недавно закрытый сверху, а не недавно открытый', async () => {
    const [base] = mockIncidents.items;
    if (!base) throw new Error('нет мок-инцидента');
    const mk = (id: string, kind: 'cpu_high' | 'mem_high', openedMinAgo: number, closedMinAgo: number) => ({
      ...base,
      id,
      kind,
      title: kind === 'cpu_high' ? 'Высокая нагрузка на CPU · de-fra-01' : 'Память на пределе · de-fra-01',
      status: 'resolved' as const,
      openedAt: new Date(Date.now() - openedMinAgo * 60_000).toISOString(),
      resolvedAt: new Date(Date.now() - closedMinAgo * 60_000).toISOString(),
      resolvedBy: 'auto' as const,
      attempts: [],
      proposal: null,
    });
    // «Давно открытый, но закрыт только что» должен быть выше «открыт позже, закрыт раньше».
    mockIncidents.items = [
      mk('7d9a2b1c-3e4f-4a5b-8c6d-9e0f1a2b3c01', 'mem_high', 60, 50),
      mk('7d9a2b1c-3e4f-4a5b-8c6d-9e0f1a2b3c02', 'cpu_high', 300, 2),
    ];
    renderPage(IncidentsPage, '/incidents', ['/incidents/$id', '/incidents/autofix']);
    const rows = await screen.findAllByTestId('incident-row');
    expect(rows[0]).toHaveTextContent('Высокая нагрузка на CPU');
    expect(rows[1]).toHaveTextContent('Память на пределе');
  });

  it('фильтры «Открытые» и «Решённые»', async () => {
    renderPage(IncidentsPage, '/incidents', ['/incidents/$id', '/incidents/autofix']);
    const user = userEvent.setup();
    await screen.findAllByTestId('incident-row');
    await user.click(screen.getByRole('button', { name: /^Открытые/ }));
    await waitFor(() => expect(screen.queryByText('Диск заполняется')).not.toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: /^Решённые/ }));
    await waitFor(() => expect(screen.queryByText('SSH недоступен')).not.toBeInTheDocument());
    expect(screen.getAllByText('Диск заполняется').length).toBeGreaterThan(0);
  });

  it('строка ведёт на страницу-кейс, кнопка — на «Автопочинку»', async () => {
    const { router } = renderPage(IncidentsPage, '/incidents', ['/incidents/$id', '/incidents/autofix']);
    const user = userEvent.setup();
    const rows = await screen.findAllByTestId('incident-row');
    await user.click(rows[0] as HTMLElement);
    await waitFor(() => expect(router.state.location.pathname).toMatch(/^\/incidents\/[0-9a-f-]+$/));
  });

  it('удаление решённых с подтверждением', async () => {
    renderPage(IncidentsPage, '/incidents', ['/incidents/$id', '/incidents/autofix']);
    const user = userEvent.setup();
    await screen.findAllByTestId('incident-row');
    await user.click(screen.getByRole('button', { name: /^Решённые/ }));
    await user.click(await screen.findByRole('button', { name: /Удалить решённые/ }));
    await user.click(await screen.findByRole('button', { name: 'Удалить' }));
    await waitFor(() => expect(mockIncidents.items.some((i) => i.status === 'resolved')).toBe(false));
    expect(await screen.findByText('Пока спокойно')).toBeInTheDocument();
  });

  it('свежий инцидент: «Ждём ещё N с — возможно, поднимется само»', async () => {
    const [base] = mockIncidents.items;
    if (!base) throw new Error('нет мок-инцидента');
    mockIncidents.items = [
      {
        ...base,
        id: '7d9a2b1c-3e4f-4a5b-8c6d-9e0f1a2b3c4d',
        kind: 'node_down',
        title: 'Контейнер ноды не запущен · nl-ams-02',
        status: 'open',
        resolvedAt: null,
        resolvedBy: null,
        openedAt: new Date(Date.now() - 10_000).toISOString(),
        attempts: [],
        proposal: null,
      },
    ];
    renderPage(IncidentsPage, '/incidents', ['/incidents/$id', '/incidents/autofix']);
    expect(await screen.findByText(/Ждём ещё \d+ с — возможно, поднимется само/)).toBeInTheDocument();
  });

  it('пустое состояние, когда инцидентов нет', async () => {
    mockIncidents.items = [];
    renderPage(IncidentsPage, '/incidents', ['/incidents/$id', '/incidents/autofix']);
    expect(await screen.findByText('Пока спокойно')).toBeInTheDocument();
  });
});

describe('IncidentCasePage', () => {
  beforeEach(() => resetMockState({ authenticated: true }));

  it('кейс: хронология, сигналы в момент сбоя, правило и подтверждение шага', async () => {
    const { IncidentCasePage } = await import('./incident-case-page');
    const id = openId();
    const { ServerModalHost } = await import('@/features/servers/server-modal-host');
    const { useServerModalStore } = await import('@/features/servers/server-modal-store');
    useServerModalStore.getState().close();
    // Как в приложении: карточку сервера показывает хозяин из AppShell
    const Page = () => (
      <>
        <IncidentCasePage id={id} />
        <ServerModalHost />
      </>
    );
    const { router } = renderPage(
      Page,
      '/incidents/$id',
      ['/incidents', '/incidents/autofix', '/servers'],
      `/incidents/${id}`,
    );
    expect(await screen.findByText('Высокая нагрузка на CPU · de-fra-01')).toBeInTheDocument();
    // B2: кнопка «Сервер» открывает карточку сервера этого инцидента поверх страницы, без перехода
    const user0 = userEvent.setup();
    await user0.click(screen.getByRole('button', { name: 'Сервер' }));
    const serverDialog = await screen.findByRole('dialog', { name: 'de-fra-01' });
    expect(router.state.location.pathname).toBe(`/incidents/${id}`);
    await user0.click(within(serverDialog).getByRole('button', { name: 'Закрыть' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'de-fra-01' })).not.toBeInTheDocument());
    // правая колонка: сигналы
    expect(screen.getByText('Сигналы в момент сбоя')).toBeInTheDocument();
    expect(screen.getByText('Контейнер ноды')).toBeInTheDocument();
    // блок «Анализ»: ассистент выключен — подсказка, куда идти
    expect(await screen.findByText(/Чтобы разбирать инциденты, задайте провайдера/)).toBeInTheDocument();
    // подтверждение шага запускает попытку
    const user = userEvent.setup();
    await user.click(screen.getAllByRole('button', { name: /^Подтвердить:/ })[0] as HTMLElement);
    await waitFor(() => expect(screen.getByTestId('attempt-block')).toBeInTheDocument(), { timeout: 4000 });
  });

  it('кейс: закрытие «Контейнер ноды не запущен» с галочкой выключает слежение', async () => {
    const { IncidentCasePage } = await import('./incident-case-page');
    const { mockServers } = await import('@/test/msw/servers-mock');
    const [base] = mockIncidents.items;
    if (!base) throw new Error('нет мок-инцидента');
    const inc = {
      ...base,
      id: '7d9a2b1c-3e4f-4a5b-8c6d-9e0f1a2b3c4e',
      kind: 'node_down' as const,
      title: 'Контейнер ноды не запущен · nl-ams-02',
      status: 'open' as const,
      resolvedAt: null,
      resolvedBy: null,
      attempts: [],
      proposal: null,
    };
    mockIncidents.items = [inc];
    const Page = () => <IncidentCasePage id={inc.id} />;
    renderPage(Page, '/incidents/$id', ['/incidents', '/incidents/autofix'], `/incidents/${inc.id}`);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Закрыть' }));
    await user.click(await screen.findByRole('checkbox', { name: /Больше не следить/ }));
    await user.click(await screen.findByRole('button', { name: 'Закрыть' }));
    await waitFor(() => expect(mockServers.items.find((s) => s.id === inc.serverId)?.nodeWatch).toBe('off'));
  });
});

describe('AttemptsAccordion', () => {
  it('раскрыта только последняя попытка, остальные — по клику', async () => {
    const { AttemptsAccordion } = await import('./incident-blocks');
    const step = (
      key: 'precheck' | 'action' | 'postcheck' | 'rollback',
      label: string,
      status: 'ok' | 'skipped',
    ) => ({
      key,
      label,
      status,
      startedAt: null,
      finishedAt: null,
      note: null,
    });
    const mk = (n: number, action: string, status: 'not_helped' | 'helped') => ({
      id: `7d9a2b1c-3e4f-4a5b-8c6d-9e0f1a2b3c0${n}`,
      action,
      level: 'T1' as const,
      by: 'manual' as const,
      status,
      startedAt: new Date(Date.now() - 60_000).toISOString(),
      finishedAt: new Date(Date.now() - 40_000).toISOString(),
      steps: [step('precheck', `Пред-проверка ${n}`, 'ok'), step('rollback', `Откат ${n}`, 'skipped')],
      log: '',
    });
    const Page = () => (
      <AttemptsAccordion
        attempts={[
          mk(1, 'free_disk', 'not_helped'),
          mk(2, 'apt_clean', 'not_helped'),
          mk(3, 'free_disk', 'helped'),
        ]}
      />
    );
    renderPage(Page, '/x');
    const user = userEvent.setup();
    const buttons = await screen.findAllByRole('button', { name: /Освободить диск|Очистить кэш apt/ });
    // последняя раскрыта, первые две свёрнуты
    expect(buttons[2]).toHaveAttribute('aria-expanded', 'true');
    expect(buttons[0]).toHaveAttribute('aria-expanded', 'false');
    expect(buttons[1]).toHaveAttribute('aria-expanded', 'false');
    // клик раскрывает вторую, третья остаётся открытой
    await user.click(buttons[1] as HTMLElement);
    expect(buttons[1]).toHaveAttribute('aria-expanded', 'true');
    expect(buttons[2]).toHaveAttribute('aria-expanded', 'true');
    // итог виден и у свёрнутой строки
    expect(buttons[0]).toHaveTextContent('не помогло');
    expect(buttons[2]).toHaveTextContent('помогло');
  });
});

describe('AutofixPage', () => {
  beforeEach(() => resetMockState({ authenticated: true }));

  it('политика по сигналам: группы, цепочка предложением, «Само» пишется в настройки', async () => {
    const { AutofixPage } = await import('./autofix-page');
    renderPage(AutofixPage, '/incidents/autofix', ['/incidents']);
    const rows = await screen.findAllByTestId('policy-row');
    expect(rows.length).toBe(6);
    const node = rows.find((r) => within(r).queryByText('Контейнер ноды не запущен'));
    if (!node) throw new Error('нет строки ноды');
    expect(node).toHaveTextContent('Поднять контейнер ноды');
    // SSH: цепочки нет — только уведомление
    const ssh = rows.find((r) => within(r).queryByText('SSH недоступен'));
    expect(ssh).toHaveTextContent('только уведомление');

    const user = userEvent.setup();
    await user.click(screen.getByRole('switch', { name: 'Автопочинка' }));
    await waitFor(() => expect(mockIncidents.settings.autofixEnabled).toBe(true));
    await user.click(within(node).getByRole('button', { name: 'Контейнер ноды не запущен: Само' }));
    await waitFor(() => expect(mockIncidents.settings.policy.node_down).toBe('auto'));
  });

  it('пауза автопочинки на час и снятие', async () => {
    const { AutofixPage } = await import('./autofix-page');
    mockIncidents.settings.autofixEnabled = true;
    renderPage(AutofixPage, '/incidents/autofix', ['/incidents']);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: /Приостановить на час/ }));
    await waitFor(() => expect(mockIncidents.settings.pausedUntil).not.toBeNull());
    expect(await screen.findByText(/На паузе ещё \d+ мин/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Снять паузу/ }));
    await waitFor(() => expect(mockIncidents.settings.pausedUntil).toBeNull());
  });
});
