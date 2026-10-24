import type { RemnawaveNode } from '@nodeservice/shared';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetMockState } from '@/test/msw/handlers';
import { mockRemnawave, mockReserve } from '@/test/msw/remnawave-mock';
import { renderPage } from '@/test/render';
import { ReserveIpsCard } from './reserve-ips';

const NODE = {
  uuid: '11111111-1111-4111-8111-111111111111',
  name: 'Германия - 1',
  address: '177.3.216.253',
  port: 2222,
  countryCode: 'DE',
  isConnected: true,
  isDisabled: false,
  isConnecting: false,
  usersOnline: 120,
} as RemnawaveNode;

beforeEach(() => {
  resetMockState({ authenticated: true });
  Object.assign(mockRemnawave, { connected: true, domain: 'panel.example.com', nodes: [{ ...NODE }] });
});

describe('Запасные IP в окне ноды', () => {
  it('рабочий адрес сверху; «Добавить и проверить» — адрес с итогом Check-Host и кнопкой «Переключить»', async () => {
    const user = userEvent.setup();
    renderPage(() => <ReserveIpsCard node={NODE} />, '/nodes');
    const card = await screen.findByRole('region', { name: 'Запасные IP' });
    expect(await within(card).findByText('177.3.216.253')).toBeVisible();
    expect(card).toHaveTextContent('Рабочий адрес · сейчас у ноды в Remnawave');
    const add = within(card).getByRole('button', { name: 'Добавить и проверить' });
    await user.type(within(card).getByLabelText('Запасной IP-адрес'), 'не адрес');
    expect(add).toBeDisabled();
    await user.clear(within(card).getByLabelText('Запасной IP-адрес'));
    await user.type(within(card).getByLabelText('Запасной IP-адрес'), '177.3.216.31');
    await user.click(add);
    expect(await within(card).findByText('177.3.216.31')).toBeVisible();
    expect(card).toHaveTextContent('Отвечает · из РФ 9 из 9, из других стран 6 из 6');
    expect(within(card).getByRole('button', { name: 'Переключить' })).toBeVisible();
    expect(within(card).getByText('1 адрес')).toBeVisible();
  });

  it('«Переключить»: что поменяется — по шагам; после — итог каждого шага, старый адрес в запасных', async () => {
    mockReserve[NODE.uuid] = {
      auto: false,
      lastSwitch: null,
      items: [
        {
          ip: '177.3.216.31',
          wasPrimaryUntil: null,
          check: { at: new Date().toISOString(), ok: true, verdict: 'reachable', text: 'Отвечает' },
        },
      ],
    };
    const user = userEvent.setup();
    renderPage(() => <ReserveIpsCard node={NODE} />, '/nodes');
    const card = await screen.findByRole('region', { name: 'Запасные IP' });
    await user.click(await within(card).findByRole('button', { name: 'Переключить' }));
    const dialog = await screen.findByRole('dialog', { name: 'Переключить «Германия - 1» на 177.3.216.31?' });
    const plan = await within(dialog).findByRole('list', { name: 'Что поменяется' });
    expect(plan).toHaveTextContent('Адрес ноды в Remnawave177.3.216.253 → 177.3.216.31Поменяется');
    expect(plan).toHaveTextContent('de.example.com · Cloudflare');
    await user.click(within(dialog).getByRole('button', { name: 'Переключить' }));
    expect(await within(dialog).findAllByText('Готово')).toHaveLength(2);
    expect(mockRemnawave.nodes[0]?.address).toBe('177.3.216.31');
    await user.click(within(dialog).getByRole('button', { name: 'Закрыть' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(await within(card).findByText(/Был рабочим до сегодня в/)).toBeVisible();
  });

  it('«Переключать само» выключено по умолчанию и недоступно без запасных; «Убрать» убирает адрес', async () => {
    const user = userEvent.setup();
    const { unmount } = renderPage(() => <ReserveIpsCard node={NODE} />, '/nodes');
    const auto = await screen.findByRole('switch', { name: 'Переключать само' });
    expect(auto).toHaveAttribute('aria-checked', 'false');
    expect(auto).toBeDisabled();
    unmount();
    mockReserve[NODE.uuid] = {
      auto: false,
      lastSwitch: null,
      items: [{ ip: '88.198.10.4', wasPrimaryUntil: null, check: null }],
    };
    renderPage(() => <ReserveIpsCard node={NODE} />, '/nodes');
    const card = await screen.findByRole('region', { name: 'Запасные IP' });
    expect((await within(card).findAllByText('Не проверен')).length).toBe(2);
    // Не проверенный адрес переключать нельзя — сначала проверка.
    expect(within(card).queryByRole('button', { name: 'Переключить' })).toBeNull();
    await user.click(screen.getByRole('switch', { name: 'Переключать само' }));
    await waitFor(() => expect(mockReserve[NODE.uuid]?.auto).toBe(true));
    await user.click(within(card).getByRole('button', { name: 'Убрать адрес 88.198.10.4' }));
    await waitFor(() => expect(within(card).queryByText('88.198.10.4')).toBeNull());
  });
});
