import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { delay, http } from 'msw';
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

  it('решённые режутся постранично; «Сейчас» с открытым видно на любой странице', async () => {
    const [base] = mockIncidents.items;
    if (!base) throw new Error('нет мок-инцидента');
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
    await user.click(screen.getByRole('button', { name: /^Открытые/ }));
    expect(screen.getAllByTestId('incident-row')).toHaveLength(1);
    await user.click(screen.getByRole('button', { name: /^Решённые/ }));
    await waitFor(() => expect(screen.getAllByTestId('incident-row')).toHaveLength(10));
    expect(screen.getByText(/1–10 из 45/)).toBeInTheDocument();
  });

  it('пустое состояние, когда инцидентов нет', async () => {
    mockIncidents.items = [];
    renderPage(IncidentsPage, '/incidents', ['/incidents/$id', '/incidents/autofix']);
    expect(await screen.findByText('Пока спокойно')).toBeInTheDocument();
  });

  /** Сорок пять решённых, по одному в час: четыре полные страницы по десять и пятая из пяти. */
  const seedResolved = () => {
    const [base] = mockIncidents.items;
    if (!base) throw new Error('нет мок-инцидента');
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
   * Решённые по дням: perDay[d] — сколько сбоев закрыто d дней назад; внутри дня — с шагом в секунду от 00:10,
   * поэтому граница дня от времени прогона не зависит. Номер строки в списке — в названии: «Сбой N».
   * `long` — строка номер `at` (с нуля) становится долгим инцидентом с заданными временами.
   */
  const seedDays = (
    perDay: number[],
    opts: { long?: { at: number; openedAt: number; resolvedAt: number } } = {},
  ) => {
    const [base] = mockIncidents.items;
    if (!base) throw new Error('нет мок-инцидента');
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
  /** Ответ списка инцидентов приходит с задержкой; сам ответ — обычный (запрос идёт дальше по обработчикам). */
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
    await user.click(await screen.findByRole('button', { name: /^Решённые/ }));
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
    await user.click(await screen.findByRole('button', { name: /^Решённые/ }));
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
    const nav = screen.getByRole('navigation', { name: 'Страницы решённых инцидентов' });
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
    await user.click(await screen.findByRole('button', { name: /^Решённые/ }));
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
    await user.click(await screen.findByRole('button', { name: /^Решённые/ }));
    await screen.findByText(/1–10 из 45/);
    await user.click(screen.getByRole('button', { name: 'Следующая' }));
    await user.click(screen.getByRole('button', { name: 'Следующая' }));
    await screen.findByText(/21–30 из 45/);
    const again = [...mockIncidents.items];
    await user.click(screen.getByRole('button', { name: /Удалить решённые/ }));
    await user.click(await screen.findByRole('button', { name: 'Удалить' }));
    await screen.findByText('Пока спокойно');
    // Решённые появились снова — столько же, границы страниц те же.
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
    await user.click(await screen.findByRole('button', { name: /^Решённые/ }));
    await screen.findByText(/1–10 из 25/);
    await user.click(screen.getByRole('button', { name: 'Следующая' }));
    await screen.findByText(/11–20 из 25/);
    await waitFor(() => expect(rowNumbers()).toEqual(range(11, 20)));
    expect(dayNotes()).toHaveLength(10);
    for (const note of dayNotes()) expect(note).toBe('1 сбой');

    // По три в день: граница страницы режет день — только он подписан «на этой странице».
    seedDays(Array.from({ length: 10 }, () => 3));
    await user.click(screen.getByRole('button', { name: /^Все/ }));
    await user.click(screen.getByRole('button', { name: /^Решённые/ }));
    await screen.findByText(/1–10 из 30/);
    await waitFor(() => expect(rowNumbers()).toEqual(range(1, 10)));
    expect(dayNotes()).toEqual(['3 сбоя', '3 сбоя', '3 сбоя', '1 сбой на этой странице']);
    await user.click(screen.getByRole('button', { name: 'Следующая' }));
    await waitFor(() => expect(rowNumbers()).toEqual(range(11, 20)));
    expect(dayNotes()).toEqual(['2 сбоя на этой странице', '3 сбоя', '3 сбоя', '2 сбоя на этой странице']);
  });

  it('долгий инцидент (открыт три дня назад, закрыт сегодня): разрезанный день в середине страницы целым не называется', async () => {
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
    await user.click(await screen.findByRole('button', { name: /^Решённые/ }));
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
    // Открытые сейчас есть — и в заглушке есть их ячейка: от неё зависит, переносится ли полоса.
    expect(placeholder).toHaveTextContent('открыто сейчас');
    expect(await screen.findByTestId('incidents-stats')).toHaveTextContent('сбоев за 7 дней');
    expect(screen.queryByTestId('incidents-stats-placeholder')).not.toBeInTheDocument();
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
    // блок «Анализ»: Джарвис выключен — подсказка, куда идти
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
    expect(buttons[0]).toHaveTextContent('Не помогло');
    expect(buttons[2]).toHaveTextContent('Помогло');
  });
});

describe('AutofixPage', () => {
  beforeEach(() => resetMockState({ authenticated: true }));

  it('политика по сигналам: группы, цепочка предложением, «Само» пишется в настройки', async () => {
    const { AutofixPage } = await import('./autofix-page');
    renderPage(AutofixPage, '/incidents/autofix', ['/incidents']);
    const rows = await screen.findAllByTestId('policy-row');
    expect(rows.length).toBe(8);
    const node = rows.find((r) => within(r).queryByText('Контейнер ноды не запущен'));
    if (!node) throw new Error('нет строки ноды');
    expect(node).toHaveTextContent('Поднять контейнер ноды');
    // SSH: цепочки нет — только уведомление
    const ssh = rows.find((r) => within(r).queryByText('SSH недоступен'));
    expect(ssh).toHaveTextContent('только уведомление');
    // J10: блокировка ноды — тоже только уведомление, панель сама шаги не выполняет
    const blocked = rows.find((r) => within(r).queryByText('Похоже на блокировку'));
    expect(blocked).toHaveTextContent('только уведомление');

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
