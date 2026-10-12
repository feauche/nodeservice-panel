import type { AssistantAdvice } from '@nodeservice/shared';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import { beforeEach, describe, expect, it } from 'vitest';

import { NodeLinkContext } from '@/features/knowledge/markdown';
import { MOCK_ADVICE_NODE, mockAssistant } from '@/test/msw/assistant-mock';
import { resetMockState } from '@/test/msw/handlers';
import { mockIncidents } from '@/test/msw/incidents-mock';
import { server } from '@/test/msw/server';
import { renderPage } from '@/test/render';
import { AdviceCard } from './advice-card';
import { LAST_CONV_KEY } from './assistant-api';

const NODE = {
  uuid: MOCK_ADVICE_NODE.uuid,
  name: MOCK_ADVICE_NODE.name,
  address: '45.12.8.20',
  port: 443,
  countryCode: 'NL',
  isConnected: true,
  isDisabled: false,
  isConnecting: false,
  lastStatusMessage: null,
  usersOnline: 0,
  trafficUsedBytes: 0,
  trafficLimitBytes: null,
};

function withNodes(
  nodes = [NODE],
  integrations: Array<{ provider: string; connected: boolean; balance: string | null }> = [],
) {
  server.use(
    http.get('/api/nodes/status', () =>
      HttpResponse.json({
        connected: true,
        domain: 'panel.example.com',
        checkedAt: new Date().toISOString(),
        error: null,
        stats: null,
        nodes,
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
        whitelist: false,
        channelMbps: null,
        note: '',
        cpuWarningPercent: null,
        memoryWarningPercent: null,
      }),
    ),
    http.get('/api/integrations', () =>
      HttpResponse.json({
        items: integrations.map((i) => ({ ...i, checkedAt: null, domains: [] })),
      }),
    ),
  );
}

const advice = (over: Partial<AssistantAdvice> = {}): AssistantAdvice => ({
  check: 'tcp',
  nodeUuid: NODE.uuid,
  nodeName: NODE.name,
  address: '45.12.8.20:443',
  reason: 'Remnawave не получает ответа от ноды три проверки подряд.',
  ...over,
});

describe('«Спросить Ассистента» со страницы события', () => {
  beforeEach(() => {
    resetMockState({ authenticated: true });
    mockAssistant.enabled = true;
  });

  const openEvent = async () => {
    const { IncidentCasePage } = await import('@/features/incidents/incident-case-page');
    const inc = mockIncidents.items.find((i) => i.status !== 'resolved');
    if (!inc) throw new Error('нет открытого мок-события');
    inc.nodeUuid = NODE.uuid;
    const Page = () => <IncidentCasePage id={inc.id} />;
    const view = renderPage(
      Page,
      '/incidents/$id',
      ['/incidents', '/assistant', '/integrations/dpi'],
      `/incidents/${inc.id}`,
    );
    return { inc, ...view };
  };

  it('первая кнопка в шапке; панель сама задаёт вопрос с меткой события и показывает совет', async () => {
    withNodes();
    let sent: unknown;
    server.events.on('request:start', async ({ request }) => {
      if (request.method === 'POST' && new URL(request.url).pathname === '/api/assistant/chat')
        sent = await request.clone().json();
    });
    const { inc } = await openEvent();
    const ask = await screen.findByRole('button', { name: 'Спросить Ассистента' });
    // Кнопка — первая в ряду действий шапки.
    expect(ask.parentElement?.firstElementChild).toBe(ask);
    await userEvent.setup().click(ask);
    const drawer = await screen.findByRole('dialog', { name: 'Ассистент' });
    expect(await within(drawer).findByText(/сначала проверьте порт снаружи/)).toBeInTheDocument();
    expect(sent).toMatchObject({
      message: `Что случилось с ${NODE.name} и что проверить?`,
      context: { kind: 'incident', id: inc.id },
    });
    expect(within(drawer).getByTestId('assistant-context')).toHaveTextContent(`Событие: ${inc.title}`);
    const card = within(drawer).getByTestId('assistant-advice');
    expect(card).toHaveTextContent('Рекомендую проверить');
    expect(card).toHaveTextContent('Порт через Check-Host');
    expect(card).toHaveTextContent('Бесплатно');
    server.events.removeAllListeners();
  });

  it('«Открыть в чате» запоминает беседу и ведёт в раздел «Ассистент»', async () => {
    withNodes();
    const { router } = await openEvent();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Спросить Ассистента' }));
    const drawer = await screen.findByRole('dialog', { name: 'Ассистент' });
    await within(drawer).findByText(/сначала проверьте порт снаружи/);
    await user.click(within(drawer).getByRole('button', { name: 'Открыть в чате' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/assistant'));
    expect(localStorage.getItem(LAST_CONV_KEY)).toBeTruthy();
  });

  it('Ассистент выключен: панель объясняет, где включить, и ничего не отправляет', async () => {
    withNodes();
    mockAssistant.enabled = false;
    await openEvent();
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Спросить Ассистента' }));
    const drawer = await screen.findByRole('dialog', { name: 'Ассистент' });
    expect(await within(drawer).findByText('Ассистент выключен')).toBeInTheDocument();
    expect(within(drawer).getByRole('link', { name: 'Настройки → Ассистент' })).toBeInTheDocument();
    expect(within(drawer).queryByLabelText('Вопрос Ассистенту')).not.toBeInTheDocument();
  });
});

describe('карточка совета', () => {
  beforeEach(() => resetMockState({ authenticated: true }));

  const renderCard = (a: AssistantAdvice, open: (uuid: string, tab?: string) => void = () => undefined) => {
    const Page = () => (
      <NodeLinkContext.Provider value={{ nodes: {}, open }}>
        <AdviceCard advice={a} />
      </NodeLinkContext.Provider>
    );
    return renderPage(Page, '/assistant', ['/integrations/dpi', '/integrations/bschecker']);
  };

  it('порт через Check-Host открывает окно ноды сразу на «Подключении»', async () => {
    withNodes();
    const opened: Array<[string, string | undefined]> = [];
    renderCard(advice(), (uuid, tab) => opened.push([uuid, tab]));
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Открыть проверку' }));
    expect(opened).toEqual([[NODE.uuid, 'connection']]);
  });

  it('DPI Checker: цена и баланс видны до нажатия, кнопка ведёт в DPI Checker с этой нодой', async () => {
    withNodes([NODE], [{ provider: 'dpi', connected: true, balance: '5.92' }]);
    const { router } = renderCard(advice({ check: 'dpi' }));
    const card = await screen.findByTestId('assistant-advice');
    expect(await within(card).findByText(/На балансе 5\.92 USD/)).toBeInTheDocument();
    expect(card).toHaveTextContent('Платно');
    await userEvent.setup().click(within(card).getByRole('button', { name: 'Открыть проверку' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/integrations/dpi'));
    expect(router.state.location.search).toMatchObject({ node: NODE.uuid });
  });

  it('интеграция не подключена — «Подключить», а ноды больше нет — кнопка неактивна', async () => {
    withNodes([NODE], [{ provider: 'bschecker', connected: false, balance: null }]);
    renderCard(advice({ check: 'bs' }));
    expect(await screen.findByRole('button', { name: 'Подключить BS Checker' })).toBeInTheDocument();
    expect(screen.getByTestId('assistant-advice')).toHaveTextContent('Не подключён');
  });

  it('ноды больше нет в Remnawave — открыть проверку нельзя', async () => {
    withNodes([]);
    renderCard(advice());
    expect(await screen.findByRole('button', { name: 'Ноды нет в Remnawave' })).toBeDisabled();
  });
});

describe('окно ноды: отметка «Сервер белого списка»', () => {
  beforeEach(() => resetMockState({ authenticated: true }));

  it('галочка в «Настройках» сохраняется вместе с остальным, в шапке появляется «БС»', async () => {
    withNodes();
    let saved: unknown;
    server.use(
      http.put('/api/nodes/:uuid/preferences', async ({ request }) => {
        const body = (await request.json()) as Record<string, unknown>;
        saved = body;
        return HttpResponse.json(body);
      }),
    );
    const { NodeDialog } = await import('@/features/nodes/node-dialog');
    const Page = () => (
      <NodeDialog node={NODE} stale={false} onClose={() => undefined} initialTab="settings" />
    );
    renderPage(Page, '/nodes');
    const box = await screen.findByRole('checkbox', { name: /Сервер белого списка \(БС\)/ });
    expect(box).not.toBeChecked();
    const user = userEvent.setup();
    await user.click(box);
    expect(box).toBeChecked();
    expect(screen.getByTitle('Сервер белого списка')).toHaveTextContent('БС');
    await user.click(screen.getByRole('button', { name: 'Сохранить' }));
    await waitFor(() => expect(saved).toMatchObject({ whitelist: true }));
  });
});
