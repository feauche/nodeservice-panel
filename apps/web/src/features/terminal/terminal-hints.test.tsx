import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { mockAssistant } from '@/test/msw/assistant-mock';
import { resetMockState } from '@/test/msw/handlers';
import { server } from '@/test/msw/server';
import { renderPage } from '@/test/render';
import { TerminalHints } from './terminal-hints';

const OUT =
  'root@de-1:~# dmesg | tail -3\n[812345.6] nf_conntrack: table full, dropping packet\nuser 203.0.113.77 connected';

function open(read: () => string = () => OUT) {
  const onInsert = vi.fn();
  const onClose = vi.fn();
  const Page = () => (
    <TerminalHints serverId="srv-1" readRecent={read} onInsert={onInsert} onClose={onClose} />
  );
  renderPage(Page, '/assistant', ['/settings/assistant']);
  return { onInsert, onClose };
}

describe('TerminalHints (C1)', () => {
  beforeEach(() => resetMockState({ authenticated: true }));

  it('ассистент не подключён: подсказка со ссылкой в настройки, кнопки объяснения нет', async () => {
    mockAssistant.enabled = false;
    open();
    expect(await screen.findByText(/задайте провайдера, модель и ключ ассистента/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Настройки → Ассистент/ })).toHaveAttribute(
      'href',
      '/settings/assistant',
    );
    expect(screen.queryByRole('button', { name: /Объяснить/ })).not.toBeInTheDocument();
  });

  it('«Объяснить»: вывод, команды с пометкой риска; «Вставить» отдаёт команду без Enter', async () => {
    mockAssistant.enabled = true;
    const { onInsert } = open();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Объяснить последние 60 строк' }));
    const hint = await screen.findByTestId('terminal-hint');
    expect(within(hint).getByText('Упёрся conntrack')).toBeInTheDocument();
    expect(screen.getByText('Меняет систему')).toBeInTheDocument();
    expect(screen.getByText(/Перед отправкой скрыто фрагментов: 1/)).toBeInTheDocument();
    await user.click(
      screen.getByRole('button', { name: 'Вставить: cat /proc/sys/net/netfilter/nf_conntrack_max' }),
    );
    expect(onInsert).toHaveBeenCalledWith('cat /proc/sys/net/netfilter/nf_conntrack_max');
    expect(onInsert.mock.calls[0]?.[0]).not.toMatch(/[\r\n]/);
  });

  it('вопрос по выводу: кнопка неактивна до двух знаков, ответ приходит, поле очищается', async () => {
    mockAssistant.enabled = true;
    open(() => 'root@de-1:~# uptime\n 10:00 up 3 days');
    const user = userEvent.setup();
    const send = await screen.findByRole('button', { name: 'Спросить' });
    expect(send).toBeDisabled();
    const field = screen.getByRole('textbox', { name: 'Вопрос по этому выводу' });
    await user.type(field, 'Всё нормально?');
    await user.click(send);
    expect(await screen.findByText(/Вы спросили: «Всё нормально\?»/)).toBeInTheDocument();
    await waitFor(() => expect(field).toHaveValue(''));
  });

  it('пустой экран терминала: понятное сообщение, запрос не уходит', async () => {
    mockAssistant.enabled = true;
    open(() => '   ');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Объяснить последние 60 строк' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('В терминале пока нет вывода');
    expect(screen.queryByTestId('terminal-hint')).not.toBeInTheDocument();
  });

  it('ошибка сервера показывается текстом, а не молчанием', async () => {
    mockAssistant.enabled = true;
    server.use(
      http.post('/api/servers/:id/terminal/hint', () =>
        HttpResponse.json(
          {
            type: 'about:blank',
            title: 'x',
            status: 502,
            detail: 'Провайдер не ответил за 60 секунд. Повторите.',
          },
          { status: 502, headers: { 'content-type': 'application/problem+json' } },
        ),
      ),
    );
    open();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Объяснить последние 60 строк' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Провайдер не ответил за 60 секунд');
  });

  it('панель закрывается крестиком', async () => {
    mockAssistant.enabled = true;
    const { onClose } = open();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Скрыть подсказки' }));
    expect(onClose).toHaveBeenCalled();
  });

  it('напоминание о приватности всегда на виду', async () => {
    mockAssistant.enabled = true;
    open();
    expect(await screen.findByText(/маскируются до отправки/)).toBeInTheDocument();
    expect(screen.getByText(/Ничего не выполняется без вас/)).toBeInTheDocument();
  });
});
