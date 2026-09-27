import { screen, within } from '@testing-library/react';
import { useState } from 'react';
import { beforeEach, describe, expect, it } from 'vitest';

import { resetMockState } from '@/test/msw/handlers';
import { mockRemnawave } from '@/test/msw/remnawave-mock';
import { mockServers, seedServers } from '@/test/msw/servers-mock';
import { renderPage } from '@/test/render';
import { ServersPage } from './servers-page';

function Harness() {
  const [tag, setTag] = useState<string | undefined>(undefined);
  return <ServersPage tag={tag} onTag={setTag} />;
}

const NODES = [
  {
    uuid: '0192f200-0000-7000-8000-000000000001',
    name: 'bridge',
    address: '203.0.113.7',
    countryCode: 'DE',
    isConnected: true,
    isDisabled: false,
    isConnecting: false,
    lastStatusMessage: null,
    usersOnline: 42,
    trafficUsedBytes: null,
    trafficLimitBytes: null,
  },
];

describe('пилюля «Remnawave» на карточке сервера (C1)', () => {
  beforeEach(() => {
    resetMockState({ authenticated: true });
    seedServers();
  });

  const cardOf = async (name: string) => (await screen.findByText(name)).closest('article') as HTMLElement;

  it('Remnawave не подключена: пилюли нет ни у одной карточки', async () => {
    renderPage(Harness, '/servers');
    const card = await cardOf('de-fra-01');
    expect(within(card).queryByText(/Remnawave/)).not.toBeInTheDocument();
  });

  it('подключена, адрес совпал: пилюля с числом онлайн; у несовпавшего сервера пилюли нет', async () => {
    // de-fra-01 — первый мок-сервер, его host 203.0.113.7 совпадает с адресом ноды bridge.
    mockRemnawave.connected = true;
    mockRemnawave.domain = 'vpn-panel.example.com';
    mockRemnawave.nodes = NODES;
    renderPage(Harness, '/servers');
    const linked = await cardOf('de-fra-01');
    expect(await within(linked).findByText('Remnawave: 42 онлайн')).toBeInTheDocument();
    const other = mockServers.items.find((s) => s.host !== '203.0.113.7');
    if (other) {
      const unlinked = await cardOf(other.name);
      expect(within(unlinked).queryByText(/Remnawave/)).not.toBeInTheDocument();
    }
  });

  it('нода отключена вручную: пилюля «не на связи», без числа онлайн', async () => {
    mockRemnawave.connected = true;
    mockRemnawave.domain = 'vpn-panel.example.com';
    mockRemnawave.nodes = [{ ...NODES[0], isDisabled: true, usersOnline: null }];
    renderPage(Harness, '/servers');
    const linked = await cardOf('de-fra-01');
    expect(await within(linked).findByText('Remnawave: не на связи')).toBeInTheDocument();
  });
});
