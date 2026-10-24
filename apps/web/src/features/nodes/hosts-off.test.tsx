import type { RemnawaveNode, ScenarioDisabledHosts } from '@nodeservice/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetMockState } from '@/test/msw/handlers';
import { mockDisabledHosts, mockRemnawave } from '@/test/msw/remnawave-mock';
import { renderPage } from '@/test/render';
import { HostsOffCard } from './hosts-off';
import { NodeCard } from './node-card';
import { NodeDialog } from './node-dialog';

const NODE = {
  uuid: '11111111-1111-4111-8111-111111111111',
  name: 'Германия - 1',
  address: '177.3.216.253',
  port: 443,
  countryCode: 'DE',
  isConnected: false,
  isDisabled: false,
  isConnecting: false,
  usersOnline: 41,
  providerName: 'Hetzner',
} as RemnawaveNode;

const OFF: ScenarioDisabledHosts['items'][number] = {
  nodeUuid: NODE.uuid,
  hosts: [
    { uuid: 'h1', name: 'Германия', address: 'de.axelvryn.ru' },
    { uuid: 'h2', name: 'Германия | Hysteria2', address: 'hy-de.axelvryn.ru' },
  ],
  rules: [{ id: 'r1', name: 'Точно лежит' }],
  at: Date.parse('2026-10-24T09:07:00Z'),
  autoRestore: true,
};

function wrap(children: React.ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(<QueryClientProvider client={client}>{children}</QueryClientProvider>);
}

beforeEach(() => resetMockState({ authenticated: true }));

describe('Host, отключённые сценарием', () => {
  it('строка ноды: метка «Host отключён · 2», в подсказке — кто и какие Host', () => {
    wrap(<NodeCard node={NODE} stale={false} onClick={vi.fn()} hostsOff={OFF} />);
    const badge = screen.getByText('Host отключён · 2');
    expect(badge.closest('[title]')).toHaveAttribute(
      'title',
      expect.stringMatching(
        /^Сценарий «Точно лежит» отключил Host в \d\d:\d\d: «Германия», «Германия \| Hysteria2»$/,
      ),
    );
  });

  it('без отключённых Host метки нет', () => {
    wrap(<NodeCard node={NODE} stale={false} onClick={vi.fn()} hostsOff={null} />);
    expect(screen.queryByText(/Host отключён/)).toBeNull();
  });

  it('блок в окне ноды: список Host, вернёт ли сценарий сам; «Вернуть Host сейчас» уходит на сервер', async () => {
    mockDisabledHosts.items = [OFF];
    const user = userEvent.setup();
    wrap(<HostsOffCard info={OFF} domain="panel.example.com" />);
    const card = screen.getByRole('region', { name: 'Host отключены панелью' });
    expect(card).toHaveTextContent(
      'Сценарий «Точно лежит» отключил Host этой ноды: клиенты не получают их в подписке.',
    );
    expect(card).toHaveTextContent('Сценарий вернёт их сам, когда нода восстановится.');
    expect(within(card).getByText('de.axelvryn.ru')).toBeInTheDocument();
    expect(within(card).getByRole('link', { name: 'Открыть Remnawave' })).toHaveAttribute(
      'href',
      'https://panel.example.com',
    );
    await user.click(within(card).getByRole('button', { name: 'Вернуть Host сейчас' }));
    await waitFor(() => expect(mockDisabledHosts.items).toEqual([]));
  });

  it('возврат в сценарии выключен — так и сказано', () => {
    wrap(<HostsOffCard info={{ ...OFF, autoRestore: false }} domain={null} />);
    expect(screen.getByRole('region')).toHaveTextContent(
      'Возврат в сценарии выключен — верните их кнопкой ниже или в Remnawave.',
    );
    expect(screen.queryByRole('link', { name: 'Открыть Remnawave' })).toBeNull();
  });

  it('окно ноды: метка под именем и блок над метриками', async () => {
    mockDisabledHosts.items = [OFF];
    Object.assign(mockRemnawave, { connected: true, domain: 'panel.example.com', nodes: [NODE] });
    renderPage(() => <NodeDialog node={NODE} stale={false} onClose={vi.fn()} />, '/node');
    const dialog = await screen.findByRole('dialog');
    expect((await within(dialog).findAllByText('Host отключён · 2')).length).toBeGreaterThan(0);
    expect(await within(dialog).findByRole('region', { name: 'Host отключены панелью' })).toBeInTheDocument();
  });
});
