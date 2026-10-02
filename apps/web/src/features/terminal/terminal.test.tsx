import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRouter, RouterProvider } from '@tanstack/react-router';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useAuthStore } from '@/features/auth/store';
import { openServer, useServerModalStore } from '@/features/servers/server-modal-store';
import { routeTree } from '@/routeTree.gen';
import { mockAssistant } from '@/test/msw/assistant-mock';
import { MOCK, mockSnippets, mockState, resetMockState } from '@/test/msw/handlers';
import { server } from '@/test/msw/server';
import { mockServers } from '@/test/msw/servers-mock';
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
  afterEach(() => act(() => useTerminalStore.getState().close()));

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
    act(() => useTerminalStore.getState().close());
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

  it('Escape не закрывает терминал: ни в меню «Сниппеты», ни после «На весь экран»', async () => {
    preflightOk();
    renderHost();
    act(() => useTerminalStore.getState().open(TARGET));
    const win = await screen.findByRole('dialog', { name: 'Терминал de-fra-01' });
    await waitFor(() => expect(MockWebSocket.instances).toHaveLength(1));
    const ws = MockWebSocket.instances[0] as MockWebSocket;
    act(() => ws.emit({ t: 'y' }));
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: 'Сниппеты' }));
    expect(await screen.findByRole('menu')).toBeInTheDocument();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
    await user.click(screen.getByRole('button', { name: 'На весь экран' }));
    await user.keyboard('{Escape}');

    expect(screen.getByRole('dialog', { name: 'Терминал de-fra-01' })).toBe(win);
    expect(useTerminalStore.getState().server?.id).toBe('srv-1');
    expect(ws.readyState).toBe(1);
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

/** Настоящее дерево маршрутов: у каждого раздела свой AppShell, окна поверх — как в приложении. */
function renderApp(path: string) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: [path] }),
    context: { queryClient },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return router;
}

/** Открыть терминал к первому серверу мока и дождаться готовой сессии. */
async function openLiveTerminal(): Promise<{ win: HTMLElement; ws: MockWebSocket; name: string }> {
  const first = mockServers.items[0];
  if (!first) throw new Error('в моке нет серверов');
  act(() =>
    useTerminalStore.getState().open({
      id: first.id,
      name: first.name,
      host: first.host,
      port: first.port,
      sshUser: first.sshUser,
    }),
  );
  const name = `Терминал ${first.name}`;
  const win = await screen.findByRole('dialog', { name });
  await waitFor(() => expect(MockWebSocket.instances).toHaveLength(1));
  const ws = MockWebSocket.instances[0] as MockWebSocket;
  act(() => ws.emit({ t: 'y' }));
  return { win, ws, name };
}

describe('терминал поверх разделов (настоящие маршруты)', () => {
  beforeEach(() => {
    sessionStorage.clear();
    useAuthStore.setState({ me: null, hydrated: false, locked: false });
    resetMockState({ authenticated: true });
    MockWebSocket.instances = [];
    vi.stubGlobal('WebSocket', MockWebSocket);
    preflightOk();
  });
  afterEach(() => {
    act(() => {
      useTerminalStore.getState().close();
      useServerModalStore.getState().close();
    });
    vi.unstubAllGlobals();
  });

  it('переход в другой раздел не закрывает SSH-сессию и не пересоздаёт окно', async () => {
    const router = renderApp('/servers');
    await screen.findByRole('heading', { level: 1, name: 'Серверы' });
    const { win, ws, name } = await openLiveTerminal();

    await act(() => router.navigate({ to: '/incidents' }));
    await screen.findByRole('heading', { level: 1, name: 'Инциденты' });
    await act(() => router.navigate({ to: '/servers/billing' }));
    await screen.findByRole('heading', { level: 1, name: 'Биллинг' });

    // То же окно и тот же сокет: сессия на сервере не закрывалась и не открывалась заново.
    expect(screen.getByRole('dialog', { name })).toBe(win);
    expect(MockWebSocket.instances).toHaveLength(1);
    expect(ws.readyState).toBe(1);
  });

  it('блокировка экрана прячет терминал, но не закрывает сессию; после разблокировки окно на месте', async () => {
    const router = renderApp('/servers');
    await screen.findByRole('heading', { level: 1, name: 'Серверы' });
    const { win, ws, name } = await openLiveTerminal();
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: 'Учётная запись' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Заблокировать экран' }));
    await screen.findByRole('heading', { name: 'Экран заблокирован' });
    expect(router.state.location.pathname).toBe('/lock');
    // Под экраном блокировки окна не видно и до него не дотянуться, но сессия жива.
    expect(win).toBeInTheDocument();
    expect(win).not.toBeVisible();
    expect(win.closest('[inert]')).not.toBeNull();
    expect(screen.queryByRole('dialog', { name })).toBeNull();
    expect(ws.readyState).toBe(1);

    await user.type(screen.getByLabelText('Пароль'), MOCK.password);
    await user.click(screen.getByRole('button', { name: 'Разблокировать' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/'));
    expect(await screen.findByRole('dialog', { name })).toBe(win);
    expect(win).toBeVisible();
    expect(win.closest('[inert]')).toBeNull();
    expect(MockWebSocket.instances).toHaveLength(1);
    expect(ws.readyState).toBe(1);
  });

  it('меню и настройка сниппетов, открытые в момент блокировки, не остаются над экраном блокировки', async () => {
    const router = renderApp('/servers');
    await screen.findByRole('heading', { level: 1, name: 'Серверы' });
    const { win, ws } = await openLiveTerminal();
    const user = userEvent.setup();
    // Блокировка по бездействию (или из другой вкладки) — без клика по меню учётной записи.
    const lockNow = () =>
      act(() => {
        useAuthStore.getState().lock();
        void router.navigate({ to: '/lock' });
      });

    await user.click(within(win).getByRole('button', { name: 'Сниппеты' }));
    expect(await screen.findByRole('menu')).toBeInTheDocument();
    lockNow();
    await screen.findByRole('heading', { name: 'Экран заблокирован' });
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
    // Открытое меню блокирует клики по странице — экран блокировки должен остаться рабочим.
    expect(document.body.style.pointerEvents).not.toBe('none');

    act(() => {
      useAuthStore.getState().unlock();
      void router.navigate({ to: '/servers' });
    });
    await screen.findByRole('heading', { level: 1, name: 'Серверы' });
    expect(screen.queryByRole('menu')).toBeNull();
    await user.click(within(win).getByRole('button', { name: 'Сниппеты' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Настроить сниппеты' }));
    expect(await screen.findByRole('dialog', { name: 'Сниппеты терминала' })).toBeInTheDocument();
    lockNow();
    await screen.findByRole('heading', { name: 'Экран заблокирован' });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Сниппеты терминала' })).toBeNull());
    expect(ws.readyState).toBe(1);
  });

  it('выход из учётной записи закрывает терминал: сессия панели кончилась', async () => {
    const router = renderApp('/servers');
    await screen.findByRole('heading', { level: 1, name: 'Серверы' });
    const { ws } = await openLiveTerminal();
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: 'Учётная запись' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Выйти' }));
    await user.click(await screen.findByRole('button', { name: 'Да, выйти' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/login'));
    expect(screen.queryByRole('dialog', { name: /^Терминал/ })).toBeNull();
    expect(ws.readyState).toBe(3);
  });

  it('сессия истекла по бездействию: терминал закрывается вместе с ней, как и сказано в «Политике»', async () => {
    const router = renderApp('/servers');
    await screen.findByRole('heading', { level: 1, name: 'Серверы' });
    const { ws } = await openLiveTerminal();

    // Сервер сессию уже не знает; панель узнаёт об этом очередным опросом статуса.
    mockState.authenticated = false;
    await act(() => router.options.context.queryClient.invalidateQueries({ queryKey: ['auth', 'status'] }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/login'));
    expect(screen.queryByRole('dialog', { name: /^Терминал/ })).toBeNull();
    expect(ws.readyState).toBe(3);
  });

  it('Escape в окне сервера закрывает только окно сервера, терминал остаётся', async () => {
    renderApp('/servers');
    await screen.findByRole('heading', { level: 1, name: 'Серверы' });
    const first = mockServers.items[0];
    if (!first) throw new Error('в моке нет серверов');
    act(() => openServer(first.id));
    const modal = await screen.findByRole('dialog', { name: first.name });
    const user = userEvent.setup();
    await user.click(within(modal).getByRole('button', { name: 'SSH-терминал' }));
    const win = await screen.findByRole('dialog', { name: `Терминал ${first.name}` });
    await waitFor(() => expect(MockWebSocket.instances).toHaveLength(1));
    const ws = MockWebSocket.instances[0] as MockWebSocket;
    act(() => ws.emit({ t: 'y' }));

    await user.click(within(modal).getByRole('button', { name: 'Журнал' }));
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: first.name })).toBeNull());
    expect(screen.getByRole('dialog', { name: `Терминал ${first.name}` })).toBe(win);
    expect(ws.readyState).toBe(1);
  });

  it('Escape внутри терминала не закрывает окно сервера и не спрашивает про несохранённое', async () => {
    renderApp('/servers');
    await screen.findByRole('heading', { level: 1, name: 'Серверы' });
    const first = mockServers.items[0];
    if (!first) throw new Error('в моке нет серверов');
    act(() => openServer(first.id, 'connection'));
    const modal = await screen.findByRole('dialog', { name: first.name });
    const user = userEvent.setup();
    // Несохранённая правка: раньше Escape из терминала открывал «Закрыть без сохранения?» с фокусом
    // на «Да, закрыть», и следующий Enter «в терминал» выбрасывал правки.
    await user.clear(within(modal).getByLabelText('Название'));
    await user.type(within(modal).getByLabelText('Название'), 'de-fra-01-new');
    await user.click(within(modal).getByRole('button', { name: 'SSH-терминал' }));
    const win = await screen.findByRole('dialog', { name: `Терминал ${first.name}` });
    await waitFor(() => expect(MockWebSocket.instances).toHaveLength(1));
    const ws = MockWebSocket.instances[0] as MockWebSocket;
    act(() => ws.emit({ t: 'y' }));

    // Фокус в рамке терминала (кнопка шапки) — Escape остаётся терминалу.
    within(win).getByRole('button', { name: 'Очистить' }).focus();
    await user.keyboard('{Escape}');
    expect(screen.getByRole('dialog', { name: first.name })).toBe(modal);
    expect(screen.queryByRole('alertdialog', { name: 'Закрыть без сохранения?' })).toBeNull();
    expect(within(modal).getByLabelText('Название')).toHaveValue('de-fra-01-new');
    expect(screen.getByRole('dialog', { name: `Терминал ${first.name}` })).toBe(win);
    expect(ws.readyState).toBe(1);
  });

  it('ссылка внутри окна сервера («Открыть в Журнале») не пересоздаёт окно и не рвёт терминал', async () => {
    const router = renderApp('/servers');
    await screen.findByRole('heading', { level: 1, name: 'Серверы' });
    const first = mockServers.items[0];
    if (!first) throw new Error('в моке нет серверов');
    act(() => openServer(first.id, 'journal'));
    const modal = await screen.findByRole('dialog', { name: first.name });
    const user = userEvent.setup();
    await user.click(within(modal).getByRole('button', { name: 'SSH-терминал' }));
    const win = await screen.findByRole('dialog', { name: `Терминал ${first.name}` });
    await waitFor(() => expect(MockWebSocket.instances).toHaveLength(1));
    const ws = MockWebSocket.instances[0] as MockWebSocket;
    act(() => ws.emit({ t: 'y' }));

    await user.click(await within(modal).findByRole('link', { name: 'Открыть в Журнале' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/audit'));
    await screen.findByRole('heading', { level: 1, name: 'Журнал' });
    expect(screen.getByRole('dialog', { name: first.name })).toBe(modal);
    expect(screen.getByRole('dialog', { name: `Терминал ${first.name}` })).toBe(win);
    expect(MockWebSocket.instances).toHaveLength(1);
    expect(ws.readyState).toBe(1);
  });

  it('жест «назад» не пересоздаёт окно сервера: несохранённые правки остаются', async () => {
    const router = renderApp('/incidents');
    await screen.findByRole('heading', { level: 1, name: 'Инциденты' });
    await act(() => router.navigate({ to: '/servers' }));
    await screen.findByRole('heading', { level: 1, name: 'Серверы' });
    const first = mockServers.items[0];
    if (!first) throw new Error('в моке нет серверов');
    act(() => openServer(first.id, 'connection'));
    const modal = await screen.findByRole('dialog', { name: first.name });
    const user = userEvent.setup();
    await user.clear(within(modal).getByLabelText('Название'));
    await user.type(within(modal).getByLabelText('Название'), 'de-fra-01-new');

    act(() => router.history.back());
    await waitFor(() => expect(router.state.location.pathname).toBe('/incidents'));
    await screen.findByRole('heading', { level: 1, name: 'Инциденты' });
    expect(screen.getByRole('dialog', { name: first.name })).toBe(modal);
    expect(within(modal).getByLabelText('Название')).toHaveValue('de-fra-01-new');
  });
});
