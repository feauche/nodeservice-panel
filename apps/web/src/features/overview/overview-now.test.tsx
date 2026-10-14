import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetMockState } from '@/test/msw/handlers';
import { mockIncidents } from '@/test/msw/incidents-mock';
import { mockRemnawave } from '@/test/msw/remnawave-mock';
import { server } from '@/test/msw/server';
import { renderPage } from '@/test/render';
import { OverviewCapacity } from './overview-capacity';
import { OverviewNow } from './overview-now';
import { OverviewStats } from './overview-stats';

const NODE = '0192f200-0000-7000-8000-000000000001';
const T0 = Date.parse('2026-10-12T16:00:00Z');

function fleetPoint(i: number, over: Record<string, number | null> = {}) {
  return {
    t: T0 + i * 60_000,
    online: 10 + i,
    rx: 1e6,
    tx: 2e6,
    ram: 30,
    load: 0.5,
    cpu: null,
    up: 1,
    nodes: 1,
    ...over,
  };
}

describe('Обзор, «Сейчас»', () => {
  beforeEach(() => {
    resetMockState({ authenticated: true });
    Object.assign(mockRemnawave, {
      connected: true,
      domain: 'panel.example.com',
      checkedAt: new Date().toISOString(),
      nodes: [
        {
          uuid: NODE,
          name: 'CDNVideo-SW',
          address: '203.0.113.7',
          countryCode: 'SE',
          isConnected: true,
          isDisabled: false,
          isConnecting: false,
          lastStatusMessage: null,
          usersOnline: 12,
          trafficUsedBytes: 0,
          trafficLimitBytes: null,
          cpuCount: 2,
          loadAverage: [0.5, 0.4, 0.3],
          memoryUsedBytes: 1024 ** 3,
          memoryTotalBytes: 4 * 1024 ** 3,
          rxBytesPerSec: 125_000_000,
          txBytesPerSec: 150_000_000,
        },
      ],
    });
    server.use(
      http.get('/api/nodes/status', () => HttpResponse.json(mockRemnawave)),
      http.get('/api/nodes/metrics', () =>
        HttpResponse.json({
          panel: mockRemnawave.domain,
          bucketSeconds: 60,
          history: [],
          fleet: [
            fleetPoint(0),
            fleetPoint(1),
            fleetPoint(2, { online: null, rx: null, tx: null, nodes: 0 }),
          ],
          onlineTypical: { low: 8, high: 14 },
          collectedSince: null,
        }),
      ),
    );
  });

  it.each(['open', 'acknowledged'] as const)(
    '%s событие видно даже при доступной ноде; строка ведёт в его страницу',
    async (status) => {
      const base = mockIncidents.items[0];
      if (!base) throw new Error('Нет тестового события');
      mockIncidents.items = [
        {
          ...base,
          nodeUuid: NODE,
          status,
          title: 'Падение онлайна · CDNVideo-SW',
          serverName: 'CDNVideo-SW',
        },
      ];
      const { router } = renderPage(OverviewNow, '/', ['/incidents/$id']);
      const link = await screen.findByRole('link', { name: /CDNVideo-SW.*Падение онлайна/ });
      // Имя ноды в заголовке события не повторяется.
      expect(link).not.toHaveTextContent('Падение онлайна · CDNVideo-SW');
      expect(link).toHaveTextContent(status === 'acknowledged' ? 'В работе' : 'Событие');
      expect(screen.getByRole('heading', { name: 'Требует внимания 1' })).toBeInTheDocument();
      await userEvent.setup().click(link);
      expect(router.state.location.pathname).toBe(`/incidents/${base.id}`);
    },
  );

  it('ошибка загрузки событий не выдаётся за «Всё спокойно»', async () => {
    server.use(http.get('/api/incidents', () => HttpResponse.json({ message: 'Ошибка' }, { status: 500 })));
    renderPage(OverviewNow, '/');
    expect(await screen.findByText(/Не удалось проверить открытые события/)).toBeInTheDocument();
    expect(screen.queryByText('Всё спокойно')).not.toBeInTheDocument();
  });

  it('решённое событие в «Требует внимания» не попадает; ниже видно, что ноды в норме', async () => {
    mockIncidents.items = mockIncidents.items.map((i) => ({ ...i, status: 'resolved' }));
    renderPage(OverviewNow, '/');
    expect(await screen.findByRole('heading', { name: 'Требует внимания 0' })).toBeInTheDocument();
    expect(screen.getByText('Всё спокойно')).toBeInTheDocument();
    expect(screen.getByText('Все 1 нода в норме')).toBeInTheDocument();
  });

  it('потеря связи и событие одной ноды не дублируются', async () => {
    const base = mockIncidents.items[0];
    const node = mockRemnawave.nodes[0];
    if (!base || !node) throw new Error('Нет фикстуры');
    node.isConnected = false;
    mockIncidents.items = [
      { ...base, nodeUuid: node.uuid, status: 'open', title: 'Нода не на связи', serverName: node.name },
    ];
    renderPage(OverviewNow, '/', ['/incidents/$id']);
    expect(await screen.findByRole('link', { name: /Нода не на связи/ })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Требует внимания 1' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Нет связи/ })).not.toBeInTheDocument();
  });

  it('нода без связи видна и до того, как открылось событие', async () => {
    const node = mockRemnawave.nodes[0];
    if (!node) throw new Error('Нет ноды');
    node.isConnected = false;
    mockIncidents.items = [];
    renderPage(OverviewNow, '/');
    expect(await screen.findByRole('button', { name: /CDNVideo-SW.*Нет связи/ })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Требует внимания 1' })).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Здоровье парка 0%' })).toBeInTheDocument();
  });

  it('полоса здоровья, карточки и сводка Remnawave — по текущим данным нод', async () => {
    mockIncidents.items = [];
    renderPage(OverviewNow, '/');
    expect(await screen.findByRole('img', { name: 'Здоровье парка 100%' })).toBeInTheDocument();
    // Первая — карточка показателя, вторая — график ниже.
    const online = screen
      .getAllByRole('heading', { name: 'Онлайн на нодах', level: 2 })[0]
      ?.closest('section');
    if (!online) throw new Error('Нет карточки онлайна');
    expect(online).toHaveTextContent('12');
    expect(online).toHaveTextContent('Обычно 8–14');
    // 125 и 150 МБ/с — это 1 и 1,2 Гбит/с; гигабиты всегда с двумя знаками.
    expect(screen.getByText('↓1,00')).toBeInTheDocument();
    expect(screen.getByText('↑1,20')).toBeInTheDocument();
    expect(screen.getByText(/Remnawave: 1 из 1 ноды на связи/)).toBeInTheDocument();
    // Нагрузка 0,5 на 2 ядрах — 0,25 на ядро.
    expect(screen.getByText('0,25')).toBeInTheDocument();
    expect(screen.getAllByTestId('sparkline').length).toBeGreaterThan(0);
  });
});

const STATS = {
  panel: 'panel.example.com',
  days: 30,
  from: '2026-09-12T17:00:00.000Z',
  to: '2026-10-12T17:00:00.000Z',
  timeZone: 'Asia/Omsk',
  collectedSince: '2026-10-11T08:05:00.000Z',
  traffic: {
    total: 41 * 1024 ** 4,
    days: [
      // Итог Remnawave за сутки по Гринвичу и замеры панели с полуночи по Гринвичу до конца периода: 24 + 17 часов.
      {
        date: '2026-10-11',
        total: 24 * 1024 ** 4,
        source: 'remnawave',
        from: '2026-10-11T00:00:00.000Z',
        to: '2026-10-12T00:00:00.000Z',
      },
      {
        date: '2026-10-12',
        total: 17 * 1024 ** 4,
        source: 'panel',
        from: '2026-10-12T00:00:00.000Z',
        to: '2026-10-12T17:00:00.000Z',
      },
    ],
    measuredSince: '2026-10-11T08:05:00.000Z',
    removed: 0,
    error: null,
  },
  online: {
    peak: 10_266,
    peakAt: '2026-10-12T16:18:00.000Z',
    average: 7_820,
    minimum: 4_574,
    bucketSeconds: 14_400,
    series: [{ t: T0, v: 7000 }],
  },
  heatmap: {
    cells: Array.from({ length: 7 }, () => Array.from({ length: 24 }, (_, h) => 1000 + h)),
    days: 2,
    peak: { from: 21, to: 1 },
    quiet: { from: 6, to: 10 },
  },
  incidents: { count: 9, downtimeMs: (2 * 60 + 14) * 60_000 },
  nodes: [
    {
      uuid: NODE,
      name: 'Бета',
      countryCode: 'SE',
      disabled: false,
      traffic: 1024 ** 4,
      share: 40,
      peakOnline: 600,
      uptime: 98.5,
      incidents: 2,
    },
    {
      uuid: '0192f200-0000-7000-8000-000000000002',
      name: 'Альфа',
      countryCode: 'DE',
      disabled: false,
      traffic: 2 * 1024 ** 4,
      share: 60,
      peakOnline: 300,
      uptime: 100,
      incidents: 0,
    },
  ],
};

describe('Обзор, «Статистика»', () => {
  beforeEach(() => {
    resetMockState({ authenticated: true });
    server.use(http.get('/api/nodes/stats', () => HttpResponse.json(STATS)));
  });

  it('пять цифр за период, часы пика и честная подпись «90 дней»', async () => {
    renderPage(OverviewStats, '/');
    // Пик — в карточке показателя и над графиком онлайна.
    expect(await screen.findAllByText('10 266')).toHaveLength(2);
    expect(screen.getByText('2 ч 14 мин', { exact: false })).toBeInTheDocument();
    expect(screen.getByText('минимум 4 574')).toBeInTheDocument();
    expect(screen.getByText(/Пик — 21:00–01:00, тише всего — 06:00–10:00/)).toBeInTheDocument();
    expect(screen.getByText(/по поясу панели, UTC\+6/)).toBeInTheDocument();
    // В среднем за сутки — итог на время, которое покрывают столбики (41 час), а не на их число и не на 30 дней.
    expect(screen.getByText('в среднем 24 ТБ в сутки')).toBeInTheDocument();
    expect(screen.getByText(/итоги Remnawave по Гринвичу/)).toBeInTheDocument();
    const locked = screen.getByRole('radio', { name: /90 дней/ });
    expect(locked).toHaveAttribute('aria-disabled', 'true');
    expect(locked).toHaveAttribute('title', 'Панель хранит замеры 30 дней');
  });

  it('таблица нод сортируется нажатием на заголовок', async () => {
    renderPage(OverviewStats, '/');
    const table = await screen.findByRole('table');
    const names = () =>
      within(table)
        .getAllByRole('row')
        .slice(1)
        .map((r) => r.textContent ?? '');
    // По умолчанию — по трафику, больше сверху.
    expect(names()[0]).toContain('Альфа');
    await userEvent.setup().click(within(table).getByRole('button', { name: /Пиковый онлайн/ }));
    expect(names()[0]).toContain('Бета');
    expect(screen.getByRole('button', { name: 'Скачать таблицу' })).toBeInTheDocument();
  });

  it('«Сутки»: трафик за последние 24 часа — два неполных столбика, без «в среднем»', async () => {
    server.use(
      http.get('/api/nodes/stats', ({ request }) =>
        HttpResponse.json(
          new URL(request.url).searchParams.get('days') === '1'
            ? {
                ...STATS,
                days: 1,
                from: '2026-10-11T17:00:00.000Z',
                traffic: {
                  ...STATS.traffic,
                  total: 3 * 1024 ** 4,
                  days: [
                    {
                      date: '2026-10-11',
                      total: 1024 ** 4,
                      source: 'panel',
                      from: '2026-10-11T17:00:00.000Z',
                      to: '2026-10-11T18:00:00.000Z',
                    },
                    {
                      date: '2026-10-12',
                      total: 2 * 1024 ** 4,
                      source: 'panel',
                      from: '2026-10-11T18:00:00.000Z',
                      to: '2026-10-12T17:00:00.000Z',
                    },
                  ],
                },
              }
            : STATS,
        ),
      ),
    );
    renderPage(OverviewStats, '/');
    await screen.findByText('в среднем 24 ТБ в сутки');
    await userEvent.setup().click(screen.getByRole('radio', { name: 'Сутки' }));
    expect(await screen.findByText('за последние 24 ч')).toBeInTheDocument();
  });
});

describe('Обзор, «Ёмкость»', () => {
  beforeEach(() => resetMockState({ authenticated: true }));

  const row = (over: Record<string, unknown>) => ({
    uuid: NODE,
    name: 'Финляндия - 1',
    countryCode: 'FI',
    cores: 4,
    peakOnline: 500,
    cpu: 60,
    ram: 40,
    channel: null,
    channelMbps: null,
    extra: 200,
    bottleneck: 'cpu',
    preliminary: true,
    skipped: null,
    days: 7,
    ...over,
  });

  it('итог по парку, узкое место и ноды без расчёта с причиной', async () => {
    server.use(
      http.get('/api/nodes/capacity', () =>
        HttpResponse.json({
          rows: [
            row({}),
            row({
              uuid: '0192f200-0000-7000-8000-000000000002',
              name: 'Польша',
              extra: 0,
              channel: 95,
              channelMbps: 1000,
              bottleneck: 'channel',
              preliminary: false,
            }),
            row({
              uuid: '0192f200-0000-7000-8000-000000000003',
              name: 'Запасная',
              skipped: 'idle',
              extra: null,
              bottleneck: null,
            }),
          ],
          calculatedAt: new Date().toISOString(),
        }),
      ),
    );
    renderPage(OverviewCapacity, '/');
    // Итог по парку и строка ноды: у второй ноды запаса нет.
    expect(await screen.findAllByText('+200')).toHaveLength(2);
    expect(screen.getByText('1 нода уже на пределе')).toBeInTheDocument();
    expect(screen.getByText('1 — предварительно, без лимита канала')).toBeInTheDocument();
    expect(screen.getByText('на пределе')).toBeInTheDocument();
    expect(screen.getByText('упирается в канал')).toBeInTheDocument();
    expect(screen.getByText(/Без расчёта: Запасная \(мало нагрузки\)/)).toBeInTheDocument();
  });

  it('лимит канала: окно по шагам, вывод замера → число, сохраняется вместе с остальными настройками ноды', async () => {
    let saved: unknown;
    server.use(
      http.get('/api/nodes/capacity', () =>
        HttpResponse.json({ rows: [row({})], calculatedAt: new Date().toISOString() }),
      ),
      http.get('/api/nodes/:uuid/preferences', () =>
        HttpResponse.json({
          whitelist: true,
          channelMbps: null,
          note: 'заметка',
          loadWarningPerCore: 1.8,
          memoryWarningPercent: null,
        }),
      ),
      http.put('/api/nodes/:uuid/preferences', async ({ request }) => {
        const body = (await request.json()) as Record<string, unknown>;
        saved = body;
        return HttpResponse.json(body);
      }),
    );
    renderPage(OverviewCapacity, '/');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Указать лимит' }));
    const dialog = await screen.findByRole('dialog', { name: /Лимит канала/ });
    // Команда для сервера на виду, пока ничего не вставлено — сохранять нечего.
    expect(dialog).toHaveTextContent(
      "cat /sys/class/net/$(ip route show default | awk '{print $5; exit}')/speed",
    );
    const save = within(dialog).getByRole('button', { name: 'Сохранить' });
    expect(save).toBeDisabled();
    // Вставили вывод замера целиком: из него берётся меньшее из Download и Upload.
    await user.click(within(dialog).getByRole('textbox', { name: 'Вывод команды или скорость канала' }));
    await user.paste('Ping: 14.2 ms\nDownload: 2910.31 Mbit/s\nUpload: 2500.07 Mbit/s');
    expect(await within(dialog).findByText(/Лимит канала: 2\s500/)).toBeVisible();
    expect(dialog).toHaveTextContent('Это меньшее из Download (2 910) и Upload (2 500)');
    await user.click(save);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(saved).toEqual({
      whitelist: true,
      channelMbps: 2500,
      note: 'заметка',
      loadWarningPerCore: 1.8,
      memoryWarningPercent: null,
    });
  });
  it('«Отмена» закрывает окно лимита без сохранения', async () => {
    let puts = 0;
    server.use(
      http.get('/api/nodes/capacity', () =>
        HttpResponse.json({ rows: [row({})], calculatedAt: new Date().toISOString() }),
      ),
      http.put('/api/nodes/:uuid/preferences', () => {
        puts += 1;
        return HttpResponse.json({});
      }),
    );
    renderPage(OverviewCapacity, '/');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Указать лимит' }));
    expect(
      await screen.findByRole('textbox', { name: 'Вывод команды или скорость канала' }),
    ).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Отмена' }));
    await waitFor(() =>
      expect(
        screen.queryByRole('textbox', { name: 'Вывод команды или скорость канала' }),
      ).not.toBeInTheDocument(),
    );
    expect(puts).toBe(0);
  });
});
