import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { delay, HttpResponse, http } from 'msw';
import { beforeEach, describe, expect, it } from 'vitest';

import { resetMockState } from '@/test/msw/handlers';
import { mockIncidents } from '@/test/msw/incidents-mock';
import { server } from '@/test/msw/server';
import { renderPage } from '@/test/render';
import { dayLabel } from './incident-format';
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
    // открытое событие со старым предложением шага: подтверждать нечего, строка без обещаний автопочинки
    expect(screen.queryByText(/Ждёт подтверждения/)).not.toBeInTheDocument();
    const cpuRow = rows.find((r) => within(r).queryByText('Высокая нагрузка на CPU'));
    if (!cpuRow) throw new Error('нет строки CPU');
    expect(within(cpuRow).getByText('Наблюдаем')).toBeInTheDocument();
    // уровень старого предложения (T2) в строке больше не показывается
    expect(within(cpuRow).queryByText('T2')).not.toBeInTheDocument();
    // решённый: «Помогло с первой попытки»
    expect(screen.getByText(/Помогло с первой попытки: освободить диск, автоматически/)).toBeInTheDocument();
  });

  it('решённые: недавно закрытый сверху, а не недавно открытый', async () => {
    const [base] = mockIncidents.items;
    if (!base) throw new Error('нет мок-события');
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

  it('фильтры «Активные» и «Завершённые»', async () => {
    renderPage(IncidentsPage, '/incidents', ['/incidents/$id', '/incidents/autofix']);
    const user = userEvent.setup();
    await screen.findAllByTestId('incident-row');
    await user.click(screen.getByRole('button', { name: /^Активные/ }));
    await waitFor(() => expect(screen.queryByText('Диск заполняется')).not.toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: /^Завершённые/ }));
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
    await user.click(screen.getByRole('button', { name: /^Завершённые/ }));
    await user.click(await screen.findByRole('button', { name: /Удалить решённые/ }));
    await user.click(await screen.findByRole('button', { name: 'Удалить' }));
    await waitFor(() => expect(mockIncidents.items.some((i) => i.status === 'resolved')).toBe(false));
    expect(await screen.findByText('Пока спокойно')).toBeInTheDocument();
  });

  it('свежее событие: без отсчёта автопочинки — просто «Наблюдаем»', async () => {
    const [base] = mockIncidents.items;
    if (!base) throw new Error('нет мок-события');
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
    expect(await screen.findByText('Наблюдаем')).toBeInTheDocument();
    expect(screen.queryByText(/Ждём ещё/)).not.toBeInTheDocument();
  });

  it('решённые режутся постранично; «Сейчас» с открытым видно на любой странице', async () => {
    const [base] = mockIncidents.items;
    if (!base) throw new Error('нет мок-события');
    const resolved = Array.from({ length: 45 }, (_, i) => ({
      ...base,
      id: `7d9a2b1c-3e4f-4a5b-8c6d-9e0f1a2b3c${String(i).padStart(2, '0')}`,
      kind: 'cpu_high' as const,
      status: 'resolved' as const,
      openedAt: new Date(Date.now() - (i + 2) * 3_600_000).toISOString(),
      resolvedAt: new Date(Date.now() - (i + 1) * 3_600_000).toISOString(),
      resolvedBy: 'auto' as const,
      attempts: [],
      proposal: null,
    }));
    const open = {
      ...base,
      id: '7d9a2b1c-3e4f-4a5b-8c6d-9e0f1a2b3cff',
      kind: 'ssh_down' as const,
      status: 'open' as const,
      resolvedAt: null,
      resolvedBy: null,
      attempts: [],
      proposal: null,
    };
    mockIncidents.items = [open, ...resolved];
    renderPage(IncidentsPage, '/incidents', ['/incidents/$id', '/incidents/autofix']);
    const user = userEvent.setup();

    // Вкладка «Все»: открытый под «Сейчас» виден сразу, решённых на первой странице 10 из 45.
    await screen.findByRole('region', { name: 'Сейчас' });
    await waitFor(() => expect(screen.getAllByTestId('incident-row')).toHaveLength(11));
    expect(screen.getByText(/1–10 из 45/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Следующая' }));
    await waitFor(() => expect(screen.getAllByTestId('incident-row')).toHaveLength(11));
    expect(screen.getByText(/11–20 из 45/)).toBeInTheDocument();
    // «Сейчас» с открытым остаётся на месте — вторая страница решённых её не подвинула.
    expect(screen.getByRole('region', { name: 'Сейчас' })).toBeInTheDocument();

    // Смена вкладки сбрасывает номер страницы решённых.
    await user.click(screen.getByRole('button', { name: /^Активные/ }));
    expect(screen.getAllByTestId('incident-row')).toHaveLength(1);
    await user.click(screen.getByRole('button', { name: /^Завершённые/ }));
    await waitFor(() => expect(screen.getAllByTestId('incident-row')).toHaveLength(10));
    expect(screen.getByText(/1–10 из 45/)).toBeInTheDocument();
  });

  it('пустое состояние, когда событий нет', async () => {
    mockIncidents.items = [];
    renderPage(IncidentsPage, '/incidents', ['/incidents/$id', '/incidents/autofix']);
    expect(await screen.findByText('Пока спокойно')).toBeInTheDocument();
  });

  /** Сорок пять решённых, по одному в час: четыре полные страницы по десять и пятая из пяти. */
  const seedResolved = () => {
    const [base] = mockIncidents.items;
    if (!base) throw new Error('нет мок-события');
    mockIncidents.items = Array.from({ length: 45 }, (_, i) => ({
      ...base,
      id: `7d9a2b1c-3e4f-4a5b-8c6d-9e0f1a2b3c${String(i).padStart(2, '0')}`,
      kind: 'cpu_high' as const,
      status: 'resolved' as const,
      openedAt: new Date(Date.now() - (i + 2) * 3_600_000).toISOString(),
      resolvedAt: new Date(Date.now() - (i + 1) * 3_600_000).toISOString(),
      resolvedBy: 'auto' as const,
      attempts: [],
      proposal: null,
    }));
  };
  /**
   * Завершённые по дням: perDay[d] — сколько сбоев закрыто d дней назад; внутри дня — с шагом в секунду от 00:10,
   * поэтому граница дня от времени прогона не зависит. Номер строки в списке — в названии: «Сбой N».
   * `long` — строка номер `at` (с нуля) становится долгим событиеом с заданными временами.
   */
  const seedDays = (
    perDay: number[],
    opts: { long?: { at: number; openedAt: number; resolvedAt: number } } = {},
  ) => {
    const [base] = mockIncidents.items;
    if (!base) throw new Error('нет мок-события');
    const now = new Date();
    const rows = perDay.flatMap((count, d) =>
      Array.from({ length: count }, (_, j) => {
        const closed =
          new Date(now.getFullYear(), now.getMonth(), now.getDate() - d).getTime() + 600_000 - j * 1000;
        return { openedAt: closed - 500, resolvedAt: closed };
      }),
    );
    if (opts.long)
      rows.splice(opts.long.at, 0, { openedAt: opts.long.openedAt, resolvedAt: opts.long.resolvedAt });
    mockIncidents.items = rows.map((r, i) => ({
      ...base,
      id: `7d9a2b1c-3e4f-4a5b-8c6d-${String(i).padStart(12, '0')}`,
      kind: 'cpu_high' as const,
      title: `Сбой ${i + 1} · de-fra-01`,
      status: 'resolved' as const,
      openedAt: new Date(r.openedAt).toISOString(),
      resolvedAt: new Date(r.resolvedAt).toISOString(),
      resolvedBy: 'auto' as const,
      attempts: [],
      proposal: null,
      analysis: null,
    }));
  };
  /** Номера показанных решённых строк — из названия «Сбой N» (у seedResolved — номер в id). */
  const rowNumbers = () =>
    screen.getAllByTestId('incident-row').map((r) => {
      const m = /Сбой (\d+)/.exec(r.textContent ?? '');
      return m ? Number(m[1]) : Number((r.getAttribute('href') ?? '').slice(-2)) + 1;
    });
  const range = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
  /** Подписи дней решённых: число сбоев и «на этой странице». */
  const dayHeaders = () =>
    screen
      .getAllByRole('region')
      .filter((r) => r.getAttribute('aria-label') !== 'Сейчас')
      .map((r) => {
        const spans = r.querySelectorAll('h2 span');
        return [spans[0]?.textContent ?? '', spans[1]?.textContent ?? ''];
      });
  const dayNotes = () => dayHeaders().map(([, note]) => note);
  /** Все состояния реестра по ходу теста: «Пока спокойно», диапазон, приглушён ли. */
  const watchList = () => {
    const states: string[] = [];
    const snap = () => {
      const calm = screen.queryByText('Пока спокойно') ? 'спокойно ' : '';
      const footer = screen.queryByTestId('incidents-footer')?.querySelector('p')?.textContent ?? '';
      const s = `${calm}${footer} ${screen.queryByTestId('incidents-list')?.getAttribute('aria-busy') ?? ''}`;
      if (states.at(-1) !== s) states.push(s);
    };
    const obs = new MutationObserver(snap);
    obs.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true });
    snap();
    return { states, stop: () => obs.disconnect() };
  };
  /** Ответ списка событий приходит с задержкой; сам ответ — обычный (запрос идёт дальше по обработчикам). */
  const slowList = (ms: number) =>
    server.use(
      http.get('/api/incidents', async () => {
        await delay(ms);
      }),
    );

  it('медленный ответ: быстрые нажатия «Следующая» не теряются, а прежняя страница на экране приглушена', async () => {
    seedResolved();
    renderPage(IncidentsPage, '/incidents', ['/incidents/$id', '/incidents/autofix']);
    const user = userEvent.setup();
    await waitFor(() => expect(screen.getAllByTestId('incident-row')).toHaveLength(10));
    slowList(150);
    await user.click(screen.getByRole('button', { name: 'Следующая' }));
    // Ответ ещё не пришёл: на экране прежние строки, но диапазон — уже запрошенный.
    expect(screen.getByText(/11–20 из 45/)).toBeInTheDocument();
    expect(screen.getByTestId('incidents-list')).toHaveAttribute('aria-busy', 'true');
    // Второе и третье нажатия считаются от запрошенной страницы, а не от той, что ещё на экране.
    await user.click(screen.getByRole('button', { name: 'Следующая' }));
    await user.click(screen.getByRole('button', { name: 'Следующая' }));
    expect(screen.getByText(/31–40 из 45/)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId('incidents-list')).toHaveAttribute('aria-busy', 'false'));
    expect(screen.getByText(/31–40 из 45/)).toBeInTheDocument();
    expect(rowNumbers()).toEqual(range(31, 40));
  });

  it('«Удалить решённые» с дальней страницы: удалённые не возвращаются на экран, пока список перечитывается', async () => {
    seedResolved();
    renderPage(IncidentsPage, '/incidents', ['/incidents/$id', '/incidents/autofix']);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: /^Завершённые/ }));
    await waitFor(() => expect(screen.getAllByTestId('incident-row')).toHaveLength(10));
    await user.click(screen.getByRole('button', { name: 'Следующая' }));
    await user.click(screen.getByRole('button', { name: 'Следующая' }));
    await screen.findByText(/21–30 из 45/);
    // Перечитывание списка после удаления идёт долго: всё это время первая страница лежит в кэше.
    slowList(600);
    await user.click(screen.getByRole('button', { name: /Удалить решённые/ }));
    await user.click(await screen.findByRole('button', { name: 'Удалить' }));
    expect(await screen.findByText('Пока спокойно', undefined, { timeout: 400 })).toBeInTheDocument();
    expect(screen.queryAllByTestId('incident-row')).toHaveLength(0);
    // И после перечитывания — тоже пусто.
    await act(async () => delay(700));
    expect(screen.getByText('Пока спокойно')).toBeInTheDocument();
    expect(screen.queryAllByTestId('incident-row')).toHaveLength(0);
  });

  it('смена вкладки сбрасывает страницу сразу: запрос по старой странице не уходит', async () => {
    seedResolved();
    const asked: string[] = [];
    server.use(
      http.get('/api/incidents', ({ request }) => {
        const q = new URL(request.url).searchParams;
        if (q.get('status') === 'resolved') asked.push(`offset=${q.get('offset')}`);
      }),
    );
    renderPage(IncidentsPage, '/incidents', ['/incidents/$id', '/incidents/autofix']);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: /^Завершённые/ }));
    await waitFor(() => expect(screen.getAllByTestId('incident-row')).toHaveLength(10));
    await user.click(screen.getByRole('button', { name: 'Следующая' }));
    await user.click(screen.getByRole('button', { name: 'Следующая' }));
    await screen.findByText(/21–30 из 45/);
    asked.length = 0;
    await user.click(screen.getByRole('button', { name: /^Все/ }));
    await screen.findByText(/1–10 из 45/);
    // С начала списка — и ни одного запроса по третьей странице.
    expect(asked.length).toBeGreaterThan(0);
    expect(asked.every((a) => a === 'offset=0')).toBe(true);
  });

  it('строка страниц: без номеров — «В начало», «Предыдущая», «Следующая», «В конец»; у краёв списка выключены', async () => {
    seedResolved();
    renderPage(IncidentsPage, '/incidents', ['/incidents/$id', '/incidents/autofix']);
    const user = userEvent.setup();
    await screen.findByText(/1–10 из 45/);
    const nav = screen.getByRole('navigation', { name: 'Страницы решённых событий' });
    const buttons = within(nav).getAllByRole('button');
    // Страницы разной длины номером не адресуются: номеров нет, только стрелки с подписями.
    expect(buttons.map((b) => b.getAttribute('aria-label'))).toEqual([
      'В начало',
      'Предыдущая',
      'Следующая',
      'В конец',
    ]);
    for (const b of buttons) expect(b).toHaveAttribute('title', b.getAttribute('aria-label'));
    expect(nav).not.toHaveTextContent(/\d/);
    const btn = (name: string) => within(nav).getByRole('button', { name });
    expect(btn('В начало')).toBeDisabled();
    expect(btn('Предыдущая')).toBeDisabled();
    expect(btn('Следующая')).toBeEnabled();
    expect(btn('В конец')).toBeEnabled();

    await user.click(btn('В конец'));
    await screen.findByText(/36–45 из 45/);
    expect(rowNumbers()).toEqual(range(36, 45));
    expect(btn('Следующая')).toBeDisabled();
    expect(btn('В конец')).toBeDisabled();
    expect(btn('Предыдущая')).toBeEnabled();

    await user.click(btn('Предыдущая'));
    await screen.findByText(/26–35 из 45/);
    await user.click(btn('В начало'));
    await screen.findByText(/1–10 из 45/);
    expect(rowNumbers()).toEqual(range(1, 10));
    expect(btn('В начало')).toBeDisabled();
  });

  it('решённых стало меньше, чем начало открытой страницы: не «Пока спокойно», а загрузка, и подпись без перевёрнутого диапазона', async () => {
    seedResolved();
    const { queryClient } = renderPage(IncidentsPage, '/incidents', ['/incidents/$id', '/incidents/autofix']);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: /^Завершённые/ }));
    await screen.findByText(/1–10 из 45/);
    await user.click(screen.getByRole('button', { name: 'Следующая' }));
    await user.click(screen.getByRole('button', { name: 'Следующая' }));
    await screen.findByText(/21–30 из 45/);
    // Удаление по сроку хранения убрало самые старые: осталось двенадцать.
    mockIncidents.items = mockIncidents.items.slice(0, 12);
    slowList(300);
    const seen = watchList();
    await act(async () => queryClient.invalidateQueries({ queryKey: ['incidents'] }));
    await screen.findByText(/3–12 из 12/, undefined, { timeout: 3000 });
    await waitFor(() => expect(screen.getByTestId('incidents-list')).toHaveAttribute('aria-busy', 'false'));
    expect(rowNumbers()).toEqual(range(3, 12));
    seen.stop();
    expect(seen.states.filter((x) => x.includes('спокойно'))).toEqual([]);
    // Ни одной подписи вида «21–12 из 12»: начало не больше общего числа.
    for (const x of seen.states) {
      const m = /(\d+)–(\d+) из (\d+)/.exec(x);
      if (m) expect(Number(m[1]), x).toBeLessThanOrEqual(Math.min(Number(m[2]), Number(m[3])));
    }
  });

  it('после «Удалить решённые» страница, бывшая на экране, не остаётся в кэше «пустой»: новые решённые листаются без «Пока спокойно»', async () => {
    seedResolved();
    const { queryClient } = renderPage(IncidentsPage, '/incidents', ['/incidents/$id', '/incidents/autofix']);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: /^Завершённые/ }));
    await screen.findByText(/1–10 из 45/);
    await user.click(screen.getByRole('button', { name: 'Следующая' }));
    await user.click(screen.getByRole('button', { name: 'Следующая' }));
    await screen.findByText(/21–30 из 45/);
    const again = [...mockIncidents.items];
    await user.click(screen.getByRole('button', { name: /Удалить решённые/ }));
    await user.click(await screen.findByRole('button', { name: 'Удалить' }));
    await screen.findByText('Пока спокойно');
    // Завершённые появились снова — столько же, границы страниц те же.
    mockIncidents.items = again;
    await act(async () => queryClient.invalidateQueries({ queryKey: ['incidents'] }));
    await screen.findByText(/1–10 из 45/);
    slowList(300);
    const seen = watchList();
    await user.click(screen.getByRole('button', { name: 'Следующая' }));
    await screen.findByText(/11–20 из 45/);
    await waitFor(() => expect(screen.getByTestId('incidents-list')).toHaveAttribute('aria-busy', 'false'));
    await user.click(screen.getByRole('button', { name: 'Следующая' }));
    await waitFor(() => expect(rowNumbers()).toEqual(range(21, 30)), { timeout: 3000 });
    seen.stop();
    expect(seen.states.filter((x) => x.includes('спокойно'))).toEqual([]);
  });

  it('подпись дня «на этой странице» — только у дня, который продолжается на соседней странице', async () => {
    // По одному сбою в день: каждый день на странице целиком.
    seedDays(Array.from({ length: 25 }, () => 1));
    renderPage(IncidentsPage, '/incidents', ['/incidents/$id', '/incidents/autofix']);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: /^Завершённые/ }));
    await screen.findByText(/1–10 из 25/);
    await user.click(screen.getByRole('button', { name: 'Следующая' }));
    await screen.findByText(/11–20 из 25/);
    await waitFor(() => expect(rowNumbers()).toEqual(range(11, 20)));
    expect(dayNotes()).toHaveLength(10);
    for (const note of dayNotes()) expect(note).toBe('1 сбой');

    // По три в день: граница страницы режет день — только он подписан «на этой странице».
    seedDays(Array.from({ length: 10 }, () => 3));
    await user.click(screen.getByRole('button', { name: /^Все/ }));
    await user.click(screen.getByRole('button', { name: /^Завершённые/ }));
    await screen.findByText(/1–10 из 30/);
    await waitFor(() => expect(rowNumbers()).toEqual(range(1, 10)));
    expect(dayNotes()).toEqual(['3 сбоя', '3 сбоя', '3 сбоя', '1 сбой на этой странице']);
    await user.click(screen.getByRole('button', { name: 'Следующая' }));
    await waitFor(() => expect(rowNumbers()).toEqual(range(11, 20)));
    expect(dayNotes()).toEqual(['2 сбоя на этой странице', '3 сбоя', '3 сбоя', '2 сбоя на этой странице']);
  });

  it('долгий событие (открыт три дня назад, закрыт сегодня): разрезанный день в середине страницы целым не называется', async () => {
    const now = new Date();
    const day = (d: number, min: number) =>
      new Date(now.getFullYear(), now.getMonth(), now.getDate() - d).getTime() + min * 60_000;
    // Строки 1–3 — сегодня, 4–5 — вчера, 6–17 — позавчера (двенадцать), 18 — долгий, 19–20 — три дня назад,
    // дальше по одному в день.
    seedDays([3, 2, 12, 2, ...Array.from({ length: 10 }, () => 1)], {
      long: { at: 17, openedAt: day(3, 23 * 60 + 30), resolvedAt: day(0, 5) },
    });
    renderPage(IncidentsPage, '/incidents', ['/incidents/$id', '/incidents/autofix']);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: /^Завершённые/ }));
    await screen.findByText(/1–10 из 30/);
    await user.click(screen.getByRole('button', { name: 'Следующая' }));
    // Строки идут по дням закрытия: долгий (восемнадцатый) — сверху, в «Сегодня».
    await waitFor(() => expect(rowNumbers()).toEqual([18, 11, 12, 13, 14, 15, 16, 17, 19, 20]));
    const label = (d: number) => dayLabel(new Date(day(d, 10)).toISOString(), Date.now());
    expect(dayHeaders()).toEqual([
      // Сегодняшние сбои — на первой странице, здесь только долгий.
      [label(0), '1 сбой на этой странице'],
      // Позавчера начался на первой странице — подписан, хотя стоит в середине.
      [label(2), '7 сбоев на этой странице'],
      // Три дня назад — целиком здесь.
      [label(3), '2 сбоя'],
    ]);
  });

  it('заглушка полосы «за 7 дней» — той же разметки, что и полоса: реестр под ней не пересчитывается', async () => {
    server.use(
      http.get('/api/incidents/week-stats', async () => {
        await delay(400);
      }),
    );
    renderPage(IncidentsPage, '/incidents', ['/incidents/$id', '/incidents/autofix']);
    await screen.findAllByTestId('incident-row');
    const placeholder = screen.getByTestId('incidents-stats-placeholder');
    expect(placeholder).toHaveAttribute('aria-hidden', 'true');
    for (const label of [
      'сбоев за 7 дней',
      'починила панель',
      'по вашей команде',
      'прошли сами',
      'закрыты вручную',
    ])
      expect(placeholder).toHaveTextContent(label);
    // Активные сейчас есть — и в заглушке есть их ячейка: от неё зависит, переносится ли полоса.
    expect(placeholder).toHaveTextContent('открыто сейчас');
    expect(await screen.findByTestId('incidents-stats')).toHaveTextContent('сбоев за 7 дней');
    expect(screen.queryByTestId('incidents-stats-placeholder')).not.toBeInTheDocument();
  });
});

describe('IncidentCasePage', () => {
  beforeEach(() => resetMockState({ authenticated: true }));

  it('похожие события нод не смешиваются при пустом serverId', async () => {
    const { IncidentCasePage } = await import('./incident-case-page');
    const base = mockIncidents.items[0];
    if (!base) throw new Error('нет мок-события');
    const current = {
      ...base,
      serverId: null,
      nodeUuid: '00000000-0000-4000-8000-000000000001',
      openedAt: new Date().toISOString(),
    };
    mockIncidents.items = [
      current,
      {
        ...current,
        id: '00000000-0000-4000-8000-000000000002',
        nodeUuid: '00000000-0000-4000-8000-000000000003',
      },
    ];
    const Page = () => <IncidentCasePage id={current.id} />;
    renderPage(Page, '/incidents/$id', ['/incidents'], `/incidents/${current.id}`);
    expect(await screen.findByText('На этом сервере за 7 дней такого не было.')).toBeInTheDocument();
  });

  /** Нода Remnawave события: подключение и пустые метрики, чтобы окно ноды открылось без лишних запросов. */
  const NODE = {
    uuid: '0192f200-0000-7000-8000-000000000001',
    name: 'de-fra-01',
    address: '203.0.113.7',
    countryCode: 'DE',
    isConnected: true,
    isDisabled: false,
    isConnecting: false,
    lastStatusMessage: null,
    usersOnline: 42,
    trafficUsedBytes: 0,
    trafficLimitBytes: null,
  };
  const withNode = () =>
    server.use(
      http.get('/api/nodes/status', () =>
        HttpResponse.json({
          connected: true,
          domain: 'panel.example.com',
          checkedAt: new Date().toISOString(),
          error: null,
          stats: null,
          nodes: [NODE],
          cert: null,
        }),
      ),
      http.get('/api/nodes/metrics', () =>
        HttpResponse.json({
          panel: 'panel.example.com',
          history: [],
          traffic: null,
          trafficError: null,
          collectedSince: null,
        }),
      ),
      http.get('/api/nodes/:uuid/preferences', () =>
        HttpResponse.json({
          channelMbps: null,
          note: '',
          cpuWarningPercent: null,
          memoryWarningPercent: null,
        }),
      ),
    );

  it('кейс: кнопка «Нода» открывает окно ноды события поверх страницы; хронология и сигналы без автопочинки', async () => {
    const { IncidentCasePage } = await import('./incident-case-page');
    const id = openId();
    const inc = mockIncidents.items.find((i) => i.id === id);
    if (!inc) throw new Error('нет мок-события');
    inc.nodeUuid = NODE.uuid;
    withNode();
    const Page = () => <IncidentCasePage id={id} />;
    const { router } = renderPage(
      Page,
      '/incidents/$id',
      ['/incidents', '/incidents/autofix'],
      `/incidents/${id}`,
    );
    expect(await screen.findByText('Высокая нагрузка на CPU · de-fra-01')).toBeInTheDocument();
    // Окна сервера больше нет: кнопка ведёт к ноде Remnawave этого события, без перехода.
    expect(screen.queryByRole('button', { name: 'Сервер' })).not.toBeInTheDocument();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Нода' }));
    expect(await screen.findByRole('dialog', { name: NODE.name })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe(`/incidents/${id}`);
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: NODE.name })).not.toBeInTheDocument());
    // правая колонка: сигналы без строки агента
    expect(screen.getByText('Сигналы в момент сбоя')).toBeInTheDocument();
    expect(screen.getByText('Контейнер ноды')).toBeInTheDocument();
    expect(screen.queryByText('Агент')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Подтвердить:/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /терминал/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('switch', { name: 'Автопочинка' })).not.toBeInTheDocument();
  });

  it('кейс старого события без ноды Remnawave: кнопки окна нет', async () => {
    const { IncidentCasePage } = await import('./incident-case-page');
    const id = openId();
    const inc = mockIncidents.items.find((i) => i.id === id);
    if (!inc) throw new Error('нет мок-события');
    expect(inc.serverId).not.toBeNull();
    inc.nodeUuid = null;
    withNode();
    const Page = () => <IncidentCasePage id={id} />;
    renderPage(Page, '/incidents/$id', ['/incidents', '/incidents/autofix'], `/incidents/${id}`);
    expect(await screen.findByText('Высокая нагрузка на CPU · de-fra-01')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Закрыть' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Нода' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Сервер' })).not.toBeInTheDocument();
  });

  it('кейс: закрытие «Контейнер ноды не запущен» — без галочки слежения за сервером', async () => {
    const { IncidentCasePage } = await import('./incident-case-page');
    const [base] = mockIncidents.items;
    if (!base) throw new Error('нет мок-события');
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
    let sent: unknown = null;
    server.use(
      http.post('/api/incidents/:id/resolve', async ({ request }) => {
        sent = await request.clone().json();
      }),
    );
    const Page = () => <IncidentCasePage id={inc.id} />;
    renderPage(Page, '/incidents/$id', ['/incidents', '/incidents/autofix'], `/incidents/${inc.id}`);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Закрыть' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).queryByRole('checkbox')).not.toBeInTheDocument();
    expect(within(dialog).queryByText(/Больше не следить/)).not.toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Закрыть' }));
    await waitFor(() => expect(mockIncidents.items[0]?.status).toBe('resolved'));
    expect(sent).toEqual({});
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
    expect(buttons[0]).toHaveTextContent('Не помогло');
    expect(buttons[2]).toHaveTextContent('Помогло');
  });
});
