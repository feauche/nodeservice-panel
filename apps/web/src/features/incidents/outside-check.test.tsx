import type { Incident, RemnawaveNode } from '@nodeservice/shared';
import { screen, within } from '@testing-library/react';
import { HttpResponse, http } from 'msw';
import { beforeEach, describe, expect, it } from 'vitest';

import { resetMockState } from '@/test/msw/handlers';
import { server } from '@/test/msw/server';
import { renderPage } from '@/test/render';
import { OutsideCheckCard, showsOutsideCheck } from './outside-check';

const UUID = 'c0000000-0000-4000-8000-000000000001';
const node = (over: Partial<RemnawaveNode> = {}) =>
  ({
    uuid: UUID,
    name: 'CONTEL',
    address: '46.8.209.86',
    port: 18443,
    whitelist: true,
    isConnected: true,
    ...over,
  }) as RemnawaveNode;
const connections = {
  primary: 'CONTEL_PL_XHTTP',
  failed: false,
  items: [
    {
      tag: 'CONTEL_PL',
      protocol: 'vless',
      security: 'reality',
      network: 'raw',
      port: 442,
      names: ['mail73.ru'],
    },
    {
      tag: 'CONTEL_PL_XHTTP',
      protocol: 'vless',
      security: 'reality',
      network: 'xhttp',
      port: 18444,
      names: ['storage.yandexcloud.net'],
    },
    {
      tag: 'CONTEL_NL',
      protocol: 'vless',
      security: 'reality',
      network: 'raw',
      port: 18443,
      names: ['ozon.ru'],
    },
    { tag: 'SS', protocol: 'shadowsocks', security: null, network: null, port: 15344, names: [] },
  ],
};
const status = (connected: Record<string, boolean>) =>
  http.get('*/api/integrations', () =>
    HttpResponse.json({
      items: ['dpi', 'bschecker'].map((provider) => ({
        provider,
        connected: connected[provider] ?? false,
        checkedAt: null,
        domains: [],
        balance: connected[provider] ? '10' : null,
      })),
    }),
  );

function mount(n: RemnawaveNode) {
  const Page = () => <OutsideCheckCard node={n} />;
  return renderPage(Page, '/incidents/x', ['/integrations/bschecker', '/integrations/dpi']);
}

beforeEach(() => {
  resetMockState({ authenticated: true });
  server.use(
    http.get(`*/api/nodes/${UUID}/connections`, () => HttpResponse.json(connections)),
    status({ dpi: true, bschecker: true }),
  );
});

describe('Событие: «Проверить снаружи»', () => {
  it('сервер белого списка: BS Checker первым, ссылка несёт ноду, порт и SNI основного подключения', async () => {
    mount(node());
    const card = await screen.findByRole('region', { name: 'Проверить снаружи' });
    const rows = within(card).getAllByRole('listitem');
    expect(rows[0]).toHaveTextContent('BS Checker · мобильные операторыдля этой ноды');
    expect(rows[1]).toHaveTextContent('DPI Checker · провайдеры РФ');
    expect(rows[1]).not.toHaveTextContent('для этой ноды');
    await within(rows[0] as HTMLElement).findByText('storage.yandexcloud.net');
    expect(rows[0]).toHaveTextContent('46.8.209.86:18444');
    expect(rows[0]).toHaveTextContent('и ещё 3 подключения ноды');
    const link = within(rows[0] as HTMLElement).getByRole('link', { name: 'Открыть проверку' });
    expect(link.getAttribute('href')).toBe(
      '/integrations/bschecker?node=c0000000-0000-4000-8000-000000000001&port=18444&sni=storage.yandexcloud.net',
    );
    expect(
      within(rows[1] as HTMLElement)
        .getByRole('link', { name: 'Открыть проверку' })
        .getAttribute('href'),
    ).toBe('/integrations/dpi?node=c0000000-0000-4000-8000-000000000001');
  });

  it('обычная нода: DPI Checker первым и «для этой ноды»', async () => {
    mount(node({ whitelist: false }));
    const card = await screen.findByRole('region', { name: 'Проверить снаружи' });
    const rows = within(card).getAllByRole('listitem');
    expect(rows[0]).toHaveTextContent('DPI Checker · провайдеры РФдля этой ноды');
    expect(rows[1]).toHaveTextContent('BS Checker · мобильные операторы');
  });

  it('подключения ноды не прочитались: порт ноды из Remnawave, без SNI', async () => {
    server.use(
      http.get(`*/api/nodes/${UUID}/connections`, () =>
        HttpResponse.json({ items: [], primary: null, failed: true }),
      ),
    );
    mount(node());
    const card = await screen.findByRole('region', { name: 'Проверить снаружи' });
    const link = await within(card).findAllByRole('link', { name: 'Открыть проверку' });
    expect(link[0]?.getAttribute('href')).toBe(
      '/integrations/bschecker?node=c0000000-0000-4000-8000-000000000001&port=18443',
    );
    expect(card).not.toHaveTextContent('SNI');
  });

  it('интеграция не подключена: кнопка «Подключить» и пояснение, без ноды в ссылке', async () => {
    server.use(status({ dpi: true, bschecker: false }));
    mount(node());
    const card = await screen.findByRole('region', { name: 'Проверить снаружи' });
    const connect = await within(card).findByRole('link', { name: 'Подключить' });
    expect(connect.getAttribute('href')).toBe('/integrations/bschecker');
    expect(card).toHaveTextContent('BS Checker не подключён — откроется его раздел');
  });

  it('карточка нужна у событий о доступности и только пока они не закрыты', () => {
    const inc = (kind: Incident['kind'], status: Incident['status']) => ({ kind, status }) as Incident;
    expect(showsOutsideCheck(inc('node_blocked', 'open'))).toBe(true);
    expect(showsOutsideCheck(inc('server_down', 'acknowledged'))).toBe(true);
    expect(showsOutsideCheck(inc('node_down', 'resolved'))).toBe(false);
    expect(showsOutsideCheck(inc('cpu_high', 'open'))).toBe(false);
  });
});
