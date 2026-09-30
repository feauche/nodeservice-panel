import type { RemnawaveNode } from '@nodeservice/shared';
import { screen, within } from '@testing-library/react';
import { useState } from 'react';
import { beforeEach, describe, expect, it } from 'vitest';

import { remnawaveApi } from '@/features/remnawave/remnawave-api';
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

  const pillOf = async (node: Partial<RemnawaveNode>, patch: Partial<typeof mockRemnawave> = {}) => {
    Object.assign(mockRemnawave, {
      connected: true,
      domain: 'vpn-panel.example.com',
      nodes: [{ ...NODES[0], ...node }],
      ...patch,
    });
    renderPage(Harness, '/servers');
    const linked = await cardOf('de-fra-01');
    return within(linked).findByText(/^Remnawave:/);
  };

  it('нода не на связи: красная «не на связи», а не зелёная «0 онлайн»', async () => {
    // Так отдаёт настоящий сервер: у включённой ноды без метрик онлайн — 0, а не «нет данных».
    const pill = await pillOf({
      isConnected: false,
      lastStatusMessage: 'Node did not respond in time',
      usersOnline: 0,
    });
    expect(pill).toHaveTextContent('Remnawave: не на связи');
    expect(pill.className).toContain('text-crit');
    expect(screen.queryByText(/онлайн/)).not.toBeInTheDocument();
  });

  it('нода выключена вручную: серая «отключена вручную» — как на странице Remnawave', async () => {
    const pill = await pillOf({ isDisabled: true, isConnected: false, usersOnline: null });
    expect(pill).toHaveTextContent('Remnawave: отключена вручную');
    expect(pill.className).toContain('text-text-3');
  });

  it('нода подключается: жёлтая «подключается», число онлайн не показываем', async () => {
    const pill = await pillOf({ isConnected: false, isConnecting: true, usersOnline: 0 });
    expect(pill).toHaveTextContent('Remnawave: подключается');
    expect(pill.className).toContain('text-warn');
  });

  it('подключена, но онлайн не пришёл: «на связи» без числа', async () => {
    const pill = await pillOf({ usersOnline: null });
    expect(pill).toHaveTextContent('Remnawave: на связи');
    expect(pill.className).toContain('text-ok');
  });

  it('чтение Remnawave не удалось: прежний снимок не выдаём за текущее — «нет данных» и когда была попытка', async () => {
    const pill = await pillOf(
      { usersOnline: 42 },
      { checkedAt: new Date(Date.now() - 7 * 60_000).toISOString(), error: 'таймаут подключения' },
    );
    expect(pill).toHaveTextContent('Remnawave: нет данных');
    expect(pill.className).toContain('text-text-3');
    // Причину панель не выдумывает: Remnawave могла и ответить — отказом или ошибкой.
    expect(pill).toHaveAttribute(
      'title',
      expect.stringContaining('Панель не смогла получить данные Remnawave'),
    );
    expect(pill).toHaveAttribute('title', expect.stringContaining('Последняя попытка: 7 мин назад'));
    expect(pill.getAttribute('title')).not.toMatch(/не отвечает|таймаут/);
    expect(screen.queryByText(/42 онлайн/)).not.toBeInTheDocument();
  });

  it('мок отдаёт онлайн как настоящий сервер: у включённой ноды без связи — ноль, а не пусто', async () => {
    const status = await remnawaveApi.connect({ domain: 'vpn-panel.example.com', apiKey: 'rw_pat_good' });
    expect(status.nodes.length).toBeGreaterThan(0);
    for (const n of status.nodes) expect(n.usersOnline === null).toBe(n.isDisabled);
    expect(status.nodes.some((n) => !n.isConnected && n.usersOnline === 0)).toBe(true);
  });
});
