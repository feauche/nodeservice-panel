import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { mockAssistant } from '@/test/msw/assistant-mock';
import { mockSnippets, resetMockState } from '@/test/msw/handlers';
import { server } from '@/test/msw/server';
import { TerminalHost } from './terminal-host';
import { useTerminalStore } from './terminal-store';

/** Управляемая заглушка WebSocket: тест открывает/шлёт сообщения от «сервера». */
class MockWebSocket {
  static instances: MockWebSocket[] = [];
  static OPEN = 1;
  readyState = 0;
  url: string;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
    queueMicrotask(() => {
      this.readyState = 1;
      this.onopen?.();
    });
  }
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.readyState = 3;
    this.onclose?.();
  }
  emit(msg: unknown) {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
}

const TARGET = { id: 'srv-1', name: 'de-fra-01', host: '203.0.113.7', port: 22, sshUser: 'root' };

/** Окно терминала читает сниппеты через React Query — нужен провайдер. */
function renderHost() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <TerminalHost />
    </QueryClientProvider>,
  );
}

function preflightOk() {
  server.use(
    http.post('/api/servers/:id/terminal', () =>
      HttpResponse.json({ url: 'ws://localhost/ws/terminal?server=srv-1' }),
    ),
  );
}

describe('terminal store', () => {
  afterEach(() => useTerminalStore.getState().close());

  it('open заполняет сервер, повторный open заменяет, close очищает', () => {
    const { open, close } = useTerminalStore.getState();
    open(TARGET);
    expect(useTerminalStore.getState().server?.id).toBe('srv-1');
    open({ ...TARGET, id: 'srv-2', name: 'nl-ams-02' });
    expect(useTerminalStore.getState().server?.id).toBe('srv-2');
    close();
    expect(useTerminalStore.getState().server).toBeNull();
  });
});

describe('TerminalHost / TerminalWindow', () => {
  beforeEach(() => {
    resetMockState({ authenticated: true });
    MockWebSocket.instances = [];
    vi.stubGlobal('WebSocket', MockWebSocket);
  });
  afterEach(() => {
    useTerminalStore.getState().close();
    vi.unstubAllGlobals();
  });

  it('окно скрыто, пока store пуст; открывается с шапкой root@host:port и кнопками', async () => {
    preflightOk();
    renderHost();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    act(() => useTerminalStore.getState().open(TARGET));
    const dialog = await screen.findByRole('dialog', { name: 'Терминал de-fra-01' });
    expect(dialog).toHaveTextContent('root@203.0.113.7:22');
    expect(screen.getByRole('button', { name: 'Закрыть' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'На весь экран' })).toBeInTheDocument();
  });

  it('сниппет из меню вставляет команду в терминал без Enter', async () => {
    preflightOk();
    mockSnippets.items = [
      { id: '11111111-1111-4111-8111-111111111111', name: 'Соединения', command: 'ss -s' },
    ];
    renderHost();
    act(() => useTerminalStore.getState().open(TARGET));
    await screen.findByRole('dialog', { name: 'Терминал de-fra-01' });
    await waitFor(() => expect(MockWebSocket.instances).toHaveLength(1));
    const ws = MockWebSocket.instances[0] as MockWebSocket;
    act(() => ws.emit({ t: 'y' }));
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Сниппеты' }));
    await user.click(await screen.findByRole('menuitem', { name: /Соединения/ }));
    await waitFor(() => expect(ws.sent.some((m) => m === JSON.stringify({ t: 'i', d: 'ss -s' }))).toBe(true));
    expect(ws.sent.some((m) => m.includes('\\n') || m.includes('\\r'))).toBe(false);
  });

  it('подсказки Джарвиса: кнопка в шапке неактивна до подключения, панель открывается и закрывается', async () => {
    // Джарвис включён: без него панель рисует ссылку в настройки, а хост в этом тесте без роутера.
    mockAssistant.enabled = true;
    preflightOk();
    renderHost();
    act(() => useTerminalStore.getState().open(TARGET));
    await screen.findByRole('dialog', { name: 'Терминал de-fra-01' });
    const toggle = screen.getByRole('button', { name: 'Подсказки Джарвиса' });
    expect(toggle).toBeDisabled();
    await waitFor(() => expect(MockWebSocket.instances).toHaveLength(1));
    act(() => (MockWebSocket.instances[0] as MockWebSocket).emit({ t: 'y' }));
    await waitFor(() => expect(toggle).toBeEnabled());
    const user = userEvent.setup();
    expect(screen.queryByRole('complementary', { name: 'Подсказки Джарвиса' })).not.toBeInTheDocument();
    await user.click(toggle);
    expect(await screen.findByRole('complementary', { name: 'Подсказки Джарвиса' })).toBeInTheDocument();
    expect(toggle).toHaveAttribute('aria-pressed', 'true');
    await user.click(screen.getByRole('button', { name: 'Скрыть подсказки' }));
    await waitFor(() =>
      expect(screen.queryByRole('complementary', { name: 'Подсказки Джарвиса' })).not.toBeInTheDocument(),
    );
  });

  it('happy-path: preflight → ws → готовность по {t:y}, ввод уходит как {t:i}', async () => {
    preflightOk();
    renderHost();
    act(() => useTerminalStore.getState().open(TARGET));
    await screen.findByRole('dialog', { name: 'Терминал de-fra-01' });

    // «Подключение по SSH …» пока ws не готов
    expect(await screen.findByText(/Подключение по SSH/)).toBeInTheDocument();

    await waitFor(() => expect(MockWebSocket.instances).toHaveLength(1));
    const ws = MockWebSocket.instances[0] as MockWebSocket;
    expect(ws.url).toContain('/ws/terminal?server=srv-1');
    expect(ws.url).toContain('cols=');

    act(() => ws.emit({ t: 'y' }));
    await waitFor(() => expect(screen.queryByText(/Подключение по SSH/)).not.toBeInTheDocument());
    // после готовности терминал шлёт resize {t:'r'}
    expect(ws.sent.some((m) => m.includes('"t":"r"'))).toBe(true);
  });

  it('обрыв ws → «Сессия завершена» с кнопкой «Открыть заново»', async () => {
    preflightOk();
    renderHost();
    act(() => useTerminalStore.getState().open(TARGET));
    await screen.findByRole('dialog');
    await waitFor(() => expect(MockWebSocket.instances).toHaveLength(1));
    const ws = MockWebSocket.instances[0] as MockWebSocket;
    act(() => ws.emit({ t: 'y' }));
    act(() => ws.close());
    expect(await screen.findByText('Сессия завершена')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Открыть заново' })).toBeInTheDocument();
  });

  it('кнопка «Закрыть» убирает окно (очищает store)', async () => {
    preflightOk();
    renderHost();
    act(() => useTerminalStore.getState().open(TARGET));
    await screen.findByRole('dialog');
    await userEvent.click(screen.getByRole('button', { name: 'Закрыть' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(useTerminalStore.getState().server).toBeNull();
  });

  it('ошибка preflight → статус ошибки с текстом', async () => {
    server.use(
      http.post('/api/servers/:id/terminal', () =>
        HttpResponse.json(
          { type: 'about:blank', title: 'Ошибка', status: 502, detail: 'SSH недоступен' },
          { status: 502 },
        ),
      ),
    );
    renderHost();
    act(() => useTerminalStore.getState().open(TARGET));
    expect(await screen.findByText('Терминал не открылся')).toBeInTheDocument();
    expect(screen.getByText('SSH недоступен')).toBeInTheDocument();
  });
});
