import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';

import { mockAnalysis } from '@/test/msw/analysis-mock';
import { mockAssistant } from '@/test/msw/assistant-mock';
import { resetMockState } from '@/test/msw/handlers';
import { mockIncidents } from '@/test/msw/incidents-mock';
import { renderPage } from '@/test/render';
import { IncidentCasePage } from './incident-case-page';

const cpuIncident = () => {
  const inc = mockIncidents.items.find((i) => i.kind === 'cpu_high');
  if (!inc) throw new Error('нет мок-инцидента CPU');
  return inc;
};

const open = (id: string) => {
  const Page = () => <IncidentCasePage id={id} />;
  return renderPage(
    Page,
    '/incidents/$id',
    ['/incidents', '/incidents/autofix', '/settings/assistant'],
    `/incidents/${id}`,
  );
};

describe('IncidentAnalysis', () => {
  beforeEach(() => {
    resetMockState({ authenticated: true });
    mockAnalysis.stepMs = 20;
  });

  it('Джарвис не подключён — подсказка со ссылкой в настройки, кнопки разбора нет', async () => {
    open(cpuIncident().id);
    expect(await screen.findByText(/задайте провайдера, модель и ключ Джарвиса/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Настройки → Джарвис/ })).toHaveAttribute(
      'href',
      '/settings/assistant',
    );
    expect(screen.queryByRole('button', { name: 'Разобрать инцидент' })).not.toBeInTheDocument();
  });

  it('разбор по кнопке выключен в разрешениях: пояснение со ссылкой, кнопки нет', async () => {
    mockAssistant.enabled = true;
    mockAssistant.permissions = { ...mockAssistant.permissions, analysis: false };
    open(cpuIncident().id);
    expect(await screen.findByText('Разбор по кнопке выключен в разрешениях Джарвиса.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Настройки → Джарвис/ })).toHaveAttribute(
      'href',
      '/settings/assistant',
    );
    expect(screen.queryByRole('button', { name: 'Разобрать инцидент' })).not.toBeInTheDocument();
  });

  it('разбор: кнопка → ход по шагам → вывод, доказательства; шаг совпал с предложением — блок один', async () => {
    mockAssistant.enabled = true;
    const inc = cpuIncident();
    open(inc.id);
    const user = userEvent.setup();
    // до разбора есть отдельное предложение панели
    expect(await screen.findByTestId('proposal-block')).toBeInTheDocument();
    await user.click(await screen.findByRole('button', { name: 'Разобрать инцидент' }));
    expect(await screen.findByText('Читаю снимок сигналов и хронологию')).toBeInTheDocument();
    // Блок перерисовывается при смене состояния, поэтому после ожидания берём его заново.
    await screen.findByText(/Процессор загружен без пауз/, {}, { timeout: 4000 });
    const block = screen.getByTestId('analysis-block');
    expect(within(block).getByText('Уверенность средняя')).toBeInTheDocument();
    expect(within(block).getByText('Метрика')).toBeInTheDocument();
    // предложение панели и шаг разбора слились в один блок
    expect(screen.queryByTestId('proposal-block')).not.toBeInTheDocument();
    const next = within(block).getByTestId('analysis-next');
    expect(next).toHaveTextContent('Перезапустить контейнер ноды');
    expect(within(next).getByText('T2')).toBeInTheDocument();
    // кнопка запускает попытку
    await user.click(within(next).getByRole('button', { name: 'Выполнить' }));
    await waitFor(() => expect(screen.getByTestId('attempt-block')).toBeInTheDocument(), { timeout: 4000 });
  });

  it('ошибка разбора показывается текстом, «Повторить разбор» запускает заново', async () => {
    mockAssistant.enabled = true;
    mockAnalysis.fail = true;
    open(cpuIncident().id);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Разобрать инцидент' }));
    expect(
      await screen.findByText(/Провайдер не ответил за 60 секунд/, {}, { timeout: 4000 }),
    ).toBeInTheDocument();
    mockAnalysis.fail = false;
    await user.click(screen.getByRole('button', { name: 'Повторить разбор' }));
    expect(await screen.findByText(/Процессор загружен без пауз/, {}, { timeout: 4000 })).toBeInTheDocument();
  });

  it('вопросы: готовый вопрос и свой, история остаётся в блоке', async () => {
    mockAssistant.enabled = true;
    open(cpuIncident().id);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Разобрать инцидент' }));
    await screen.findByText(/Процессор загружен без пауз/, {}, { timeout: 4000 });
    await user.click(screen.getByRole('button', { name: 'Как не допустить повтора?' }));
    const log = await screen.findByRole('log', { name: 'Вопросы по разбору' });
    await waitFor(() => expect(within(log).getByText(/По этому инциденту/)).toBeInTheDocument());
    // готовых вопросов после первого ответа больше нет, работает поле
    expect(screen.queryByRole('button', { name: 'Что проверить ещё?' })).not.toBeInTheDocument();
    const field = screen.getByRole('textbox', { name: 'Вопрос по этому инциденту' });
    const send = screen.getByRole('button', { name: 'Спросить' });
    expect(send).toBeDisabled();
    await user.type(field, 'Почему так?');
    await user.click(send);
    await waitFor(() => expect(within(log).getByText('Почему так?')).toBeInTheDocument());
    expect(field).toHaveValue('');
  });

  it('устаревший разбор: пометка и нет кнопки шага; «Разобрать заново» на месте', async () => {
    mockAssistant.enabled = true;
    const inc = cpuIncident();
    inc.analysis = {
      status: 'done',
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      steps: [],
      verdict: 'Процессор загружен без пауз.',
      confidence: 'medium',
      evidence: [],
      unknown: null,
      nextAction: 'restart_node',
      basedOn: { attempts: inc.attempts.length + 1, resolved: false },
      model: 'm',
      error: null,
      thread: [],
    };
    open(inc.id);
    expect(await screen.findByText('Устарел')).toBeInTheDocument();
    expect(screen.getByText(/Разбор описывает прежнее состояние/)).toBeInTheDocument();
    expect(screen.queryByTestId('analysis-next')).not.toBeInTheDocument();
    // без слияния предложение панели остаётся отдельным блоком
    expect(screen.getByTestId('proposal-block')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Разобрать заново' })).toBeInTheDocument();
  });

  it('готовый разбор при выключенном разрешении: вывод виден, вопросов и повторного разбора нет', async () => {
    mockAssistant.enabled = true;
    mockAssistant.permissions = { ...mockAssistant.permissions, analysis: false };
    const inc = cpuIncident();
    inc.analysis = {
      status: 'done',
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      steps: [],
      verdict: 'Процессор загружен без пауз.',
      confidence: 'medium',
      evidence: [],
      unknown: null,
      nextAction: null,
      basedOn: { attempts: inc.attempts.length, resolved: false },
      model: 'm',
      error: null,
      thread: [],
    };
    open(inc.id);
    expect(await screen.findByText(/Процессор загружен без пауз/)).toBeInTheDocument();
    await screen.findByText('Вопросы по разбору выключены в разрешениях Джарвиса.');
    expect(screen.queryByRole('button', { name: 'Разобрать заново' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Как не допустить повтора?' })).not.toBeInTheDocument();
    expect(
      screen.getByRole('textbox', { hidden: true, name: 'Вопрос по этому инциденту' }),
    ).not.toBeVisible();
  });

  it('график: у инцидента про диск виден порог, момент открытия и попытки', async () => {
    mockAssistant.enabled = true;
    const base = cpuIncident();
    const now = Date.now();
    const iso = (minAgo: number) => new Date(now - minAgo * 60_000).toISOString();
    const inc = {
      ...base,
      id: '7d9a2b1c-3e4f-4a5b-8c6d-9e0f1a2b3c99',
      kind: 'disk_high' as const,
      title: 'Диск заполняется · de-fra-01',
      openedAt: iso(20),
      proposal: null,
      attempts: [
        {
          ...(mockIncidents.items.find((i) => i.attempts.length > 0)?.attempts[0] as never as object),
          id: 'at1',
          startedAt: iso(15),
          action: 'free_disk',
        },
      ] as never,
      analysis: {
        status: 'done' as const,
        startedAt: iso(1),
        finishedAt: iso(1),
        steps: [],
        verdict: 'Диск занят временными файлами.',
        confidence: 'high' as const,
        evidence: [{ source: 'inspect' as const, text: '27 ГБ в /tmp.' }],
        unknown: null,
        nextAction: null,
        basedOn: { attempts: 1, resolved: false },
        model: 'm',
        error: null,
        thread: [],
      },
    };
    mockIncidents.items = [inc];
    open(inc.id);
    const chart = await screen.findByTestId('analysis-chart', {}, { timeout: 4000 });
    expect(within(chart).getByText('Порог 85 %')).toBeInTheDocument();
    expect(within(chart).getAllByText('Открыт').length).toBeGreaterThan(0);
    expect(within(chart).getByRole('img', { name: /Диск: от \d+ % до \d+ %/ })).toBeInTheDocument();
    expect(within(chart).getByText('Освободить диск')).toBeInTheDocument();
  });

  it('у инцидента без метрики (ssh) графика нет, доказательства текстом', async () => {
    mockAssistant.enabled = true;
    const inc = mockIncidents.items.find((i) => i.kind === 'ssh_down');
    if (!inc) throw new Error('нет мок-инцидента ssh');
    inc.analysis = {
      status: 'done',
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      steps: [],
      verdict: 'Сервер не отвечает по SSH.',
      confidence: 'low',
      evidence: [{ source: 'other', text: 'Проверка связи не проходит.' }],
      unknown: 'Причину без доступа установить нельзя.',
      nextAction: null,
      basedOn: { attempts: inc.attempts.length, resolved: false },
      model: 'm',
      error: null,
      thread: [],
    };
    open(inc.id);
    expect(await screen.findByText('Проверка связи не проходит.')).toBeInTheDocument();
    expect(screen.queryByTestId('analysis-chart')).not.toBeInTheDocument();
    expect(screen.getByText('Уверенность низкая')).toBeInTheDocument();
    expect(screen.getByText('Причину без доступа установить нельзя.')).toBeInTheDocument();
  });
});
