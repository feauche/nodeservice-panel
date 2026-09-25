import type { AssistantProposal } from '@nodeservice/shared';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';

import { resetMockState } from '@/test/msw/handlers';
import { mockIncidents } from '@/test/msw/incidents-mock';
import { renderPage } from '@/test/render';
import { ProposalCard } from './proposal-card';

const cpu = () => {
  const inc = mockIncidents.items.find((i) => i.kind === 'cpu_high');
  if (!inc) throw new Error('нет мок-инцидента CPU');
  return inc;
};

const proposal = (over: Partial<AssistantProposal> = {}): AssistantProposal => ({
  kind: 'autofix',
  incidentId: cpu().id,
  preset: 'restart_node',
  title: 'Название от модели',
  description: 'Описание от модели.',
  level: 'T2',
  reason: 'CPU выше порога, перезапуск помогал раньше.',
  ...over,
});

function open(p: AssistantProposal, createdAt = new Date().toISOString()) {
  const Page = () => <ProposalCard proposal={p} createdAt={createdAt} />;
  return renderPage(Page, '/assistant', ['/incidents/$id', '/incidents']);
}

describe('ProposalCard (A3)', () => {
  beforeEach(() => resetMockState({ authenticated: true }));

  it('показывает название и последствия из реестра, уровень и причину; название модели игнорируется', async () => {
    open(proposal());
    const card = await screen.findByTestId('proposal-card');
    expect(within(card).getByText('Перезапустить контейнер ноды')).toBeInTheDocument();
    expect(within(card).queryByText('Название от модели')).not.toBeInTheDocument();
    expect(within(card).getByText('T2')).toBeInTheDocument();
    expect(within(card).getByText('Нужно ваше подтверждение')).toBeInTheDocument();
    expect(within(card).getByText(/CPU выше порога, перезапуск помогал раньше/)).toBeInTheDocument();
    expect(
      within(card)
        .getByText(/Что будет:/)
        .closest('p'),
    ).toHaveTextContent('Соединения пользователей оборвутся');
    expect(within(card).getByText(/Перед запуском проверим/)).toBeInTheDocument();
  });

  it('уровень без поля берётся из реестра; причина без поля — из описания (старые карточки)', async () => {
    open(proposal({ level: undefined, reason: undefined }));
    const card = await screen.findByTestId('proposal-card');
    expect(within(card).getByText('T2')).toBeInTheDocument();
    expect(within(card).getByText(/Описание от модели/)).toBeInTheDocument();
  });

  it('«Выполнить» запускает шаг; ход показывается в карточке, потом «Помогло»', async () => {
    open(proposal());
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Выполнить' }));
    const steps = await screen.findByRole('list', { name: 'Ход выполнения' }, { timeout: 4000 });
    expect(within(steps).getByText('Проверка')).toBeInTheDocument();
    expect(within(steps).getByText('Пост-проверка')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText('Помогло')).toBeInTheDocument(), { timeout: 8000 });
    // кнопки запуска больше нет, чтобы не запустить второй раз
    expect(screen.queryByRole('button', { name: 'Выполнить' })).not.toBeInTheDocument();
    expect(screen.getByText('Инцидент закрыт.')).toBeInTheDocument();
  });

  it('закрытый инцидент: запуска нет, сказано почему', async () => {
    cpu().status = 'resolved';
    open(proposal());
    expect(await screen.findByText('Инцидент уже закрыт.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Выполнить' })).not.toBeInTheDocument();
  });

  it('на сервере идёт чужая попытка: запуск недоступен', async () => {
    const inc = cpu();
    inc.attempts = [
      {
        id: 'x',
        action: 'reboot',
        level: 'T3',
        by: 'auto',
        status: 'running',
        startedAt: new Date().toISOString(),
        finishedAt: null,
        steps: [],
        log: '',
      },
    ];
    open(proposal());
    expect(await screen.findByText('На сервере уже идёт другая попытка, дождитесь её.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Выполнить' })).not.toBeInTheDocument();
  });

  it('инцидента нет: карточка не ссылается на него', async () => {
    open(proposal({ incidentId: '0192c000-0000-7000-8000-0000000000ff' }));
    expect(await screen.findByText('Инцидента больше нет.')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Открыть инцидент' })).not.toBeInTheDocument();
  });

  it('попытка, сделанная до этого сообщения, к карточке не относится', async () => {
    const inc = cpu();
    inc.attempts = [
      {
        id: 'old',
        action: 'restart_node',
        level: 'T2',
        by: 'manual',
        status: 'not_helped',
        startedAt: '2026-01-01T00:00:00.000Z',
        finishedAt: '2026-01-01T00:01:00.000Z',
        steps: [],
        log: '',
      },
    ];
    open(proposal());
    expect(await screen.findByRole('button', { name: 'Выполнить' })).toBeInTheDocument();
    expect(screen.queryByText('Не помогло')).not.toBeInTheDocument();
  });
});
