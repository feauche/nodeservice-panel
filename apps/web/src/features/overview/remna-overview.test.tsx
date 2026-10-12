import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetMockState } from '@/test/msw/handlers';
import { mockIncidents } from '@/test/msw/incidents-mock';
import { mockRemnawave } from '@/test/msw/remnawave-mock';
import { server } from '@/test/msw/server';
import { renderPage } from '@/test/render';
import { RemnaOverview } from './remna-overview';

const Page = () => <RemnaOverview view="now" />;
describe('Обзор Remnawave: открытые инциденты', () => {
  beforeEach(() => {
    resetMockState({ authenticated: true });
    Object.assign(mockRemnawave, {
      connected: true,
      domain: 'panel.example.com',
      checkedAt: new Date().toISOString(),
      nodes: [
        {
          uuid: '0192f200-0000-7000-8000-000000000001',
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
        },
      ],
    });
    server.use(
      http.get('/api/nodes/status', () => HttpResponse.json(mockRemnawave)),
      http.get('/api/nodes/metrics', () =>
        HttpResponse.json({
          panel: mockRemnawave.domain,
          history: [],
          traffic: null,
          trafficError: null,
          collectedSince: null,
        }),
      ),
    );
  });
  it.each(['open', 'acknowledged'] as const)(
    'показывает %s инцидент даже при доступной ноде; ссылка ведёт в кейс',
    async (status) => {
      const base = mockIncidents.items[0];
      if (!base) throw new Error('Нет тестового инцидента');
      mockIncidents.items = [
        {
          ...base,
          nodeUuid: '0192f200-0000-7000-8000-000000000001',
          status,
          title: 'Падение онлайна',
          serverName: 'CDNVideo-SW',
        },
      ];
      const { router } = renderPage(Page, '/', ['/incidents/$id']);
      const link = await screen.findByRole('link', { name: /CDNVideo-SW.*Падение онлайна/ });
      expect(screen.queryByText('Нет открытых инцидентов')).not.toBeInTheDocument();
      expect(screen.getByRole('heading', { name: 'Требует внимания 1' })).toBeInTheDocument();
      await userEvent.setup().click(link);
      expect(router.state.location.pathname).toBe(`/incidents/${base.id}`);
    },
  );
  it('ошибка загрузки не выдаётся за отсутствие проблем', async () => {
    server.use(http.get('/api/incidents', () => HttpResponse.json({ message: 'Ошибка' }, { status: 500 })));
    renderPage(Page, '/');
    expect(await screen.findByText(/Не удалось проверить открытые инциденты/)).toBeInTheDocument();
    expect(screen.queryByText('Нет открытых инцидентов')).not.toBeInTheDocument();
  });
  it('решённый инцидент не включается в список внимания', async () => {
    mockIncidents.items = mockIncidents.items.map((i) => ({ ...i, status: 'resolved' }));
    renderPage(Page, '/');
    expect(await screen.findByRole('heading', { name: 'Требует внимания 0' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Падение онлайна/ })).not.toBeInTheDocument();
  });
  it('потеря связи и инцидент одной ноды не дублируются', async () => {
    const base = mockIncidents.items[0];
    const node = mockRemnawave.nodes[0];
    if (!base || !node) throw new Error('Нет фикстуры');
    node.isConnected = false;
    mockIncidents.items = [
      { ...base, nodeUuid: node.uuid, status: 'open', title: 'Нода не на связи', serverName: node.name },
    ];
    renderPage(Page, '/', ['/incidents/$id']);
    expect(await screen.findByRole('link', { name: /Нода не на связи/ })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Требует внимания 1' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Нет связи/ })).not.toBeInTheDocument();
  });
  it('потеря связи отображается и до создания инцидента', async () => {
    const node = mockRemnawave.nodes[0];
    if (!node) throw new Error('Нет ноды');
    node.isConnected = false;
    mockIncidents.items = [];
    renderPage(Page, '/');
    expect(await screen.findByRole('button', { name: /CDNVideo-SW.*Нет связи/ })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Требует внимания 1' })).toBeInTheDocument();
  });
});
