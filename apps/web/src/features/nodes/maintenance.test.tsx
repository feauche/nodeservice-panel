import type { NodeMaintenance, RemnawaveNode } from '@nodeservice/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { nodeHealth } from '@/features/overview/overview-format';
import { mockMaintenanceHosts, mockRemnawave } from '@/test/msw/remnawave-mock';
import { MaintenanceCard, MaintenanceDialog, maintenanceLeft } from './maintenance';
import { NodeCard } from './node-card';

const NODE: RemnawaveNode = {
  uuid: '11111111-1111-4111-8111-111111111111',
  name: 'Германия - 1',
  address: '177.3.216.253',
  port: 443,
  countryCode: 'DE',
  isConnected: false,
  isDisabled: false,
  isConnecting: false,
  usersOnline: 0,
  providerName: 'Hetzner',
} as RemnawaveNode;

function wrap(children: ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(<QueryClientProvider client={client}>{children}</QueryClientProvider>);
}
function seed(m: NodeMaintenance | null = null) {
  const node = { ...NODE, maintenance: m };
  Object.assign(mockRemnawave, { connected: true, domain: 'panel.example.com', nodes: [node] });
  return node;
}
const running = (minutesLeft: number | null, extra: Partial<NodeMaintenance> = {}): NodeMaintenance => ({
  nodeUuid: NODE.uuid,
  nodeName: NODE.name,
  startedAt: new Date(Date.now() - 13 * 60_000).toISOString(),
  until: minutesLeft === null ? null : new Date(Date.now() + minutesLeft * 60_000).toISOString(),
  reason: 'Обновляю ядро',
  hideHosts: true,
  hosts: { hidden: ['Германия', 'Германия | Hysteria2'], shared: 0, error: null },
  ...extra,
});

describe('окно «Обслуживание ноды»', () => {
  it('по умолчанию час; видно, что замолчит; «Скрыть Host» показывает, какие Host скроются', async () => {
    const user = userEvent.setup();
    seed();
    mockMaintenanceHosts[NODE.uuid] = {
      hosts: [{ uuid: 'h1', name: 'Германия', address: 'de.axelvryn.ru', port: 443 }],
      shared: 1,
      alreadyHidden: 0,
    };
    wrap(<MaintenanceDialog node={NODE} onClose={vi.fn()} />);
    const dialog = screen.getByRole('dialog', { name: 'Обслуживание ноды «Германия - 1»' });
    expect(within(dialog).getByRole('radio', { name: '1 час' })).toHaveAttribute('aria-checked', 'true');
    expect(dialog).toHaveTextContent('Закончится само в');
    for (const text of [
      'События по ноде не заводятся',
      'Сообщений в Telegram нет',
      'Сценарии ноду пропускают',
      'Автозамена DNS ждёт',
    ])
      expect(dialog).toHaveTextContent(text);
    expect(within(dialog).queryByRole('list', { name: 'Host, которые скроются' })).toBeNull();
    await user.click(within(dialog).getByRole('switch'));
    const list = await within(dialog).findByRole('list', { name: 'Host, которые скроются' });
    expect(list).toHaveTextContent('Германия');
    expect(list).toHaveTextContent('de.axelvryn.ru:443');
    expect(dialog).toHaveTextContent('общих Host нескольких нод не трогаем: 1');
  });

  it('«До выключения» — без срока; включение уходит с причиной и закрывает окно', async () => {
    const user = userEvent.setup();
    seed();
    const onClose = vi.fn();
    wrap(<MaintenanceDialog node={NODE} onClose={onClose} />);
    const dialog = screen.getByRole('dialog');
    await user.click(within(dialog).getByRole('radio', { name: 'До выключения' }));
    expect(dialog).toHaveTextContent('Без срока: обслуживание идёт, пока вы не нажмёте «Закончить».');
    await user.type(within(dialog).getByRole('textbox', { name: /Причина/ }), 'Обновляю ядро');
    await user.click(within(dialog).getByRole('button', { name: 'Включить обслуживание' }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(mockRemnawave.nodes[0]?.maintenance).toMatchObject({
      until: null,
      reason: 'Обновляю ядро',
      hideHosts: false,
    });
  });

  it('нода пропала из Remnawave — ошибка словами в окне, окно не закрывается', async () => {
    const user = userEvent.setup();
    Object.assign(mockRemnawave, { connected: true, nodes: [] });
    const onClose = vi.fn();
    wrap(<MaintenanceDialog node={NODE} onClose={onClose} />);
    await user.click(screen.getByRole('button', { name: 'Включить обслуживание' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Нода не найдена в Remnawave.');
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe('карточка идущего обслуживания', () => {
  it('сколько осталось, причина, скрытые Host; «+1 час» продлевает, «Закончить» снимает', async () => {
    const user = userEvent.setup();
    const m = running(47);
    seed(m);
    wrap(<MaintenanceCard node={NODE} m={m} />);
    const card = screen.getByRole('region', { name: 'Обслуживание ноды' });
    expect(card).toHaveTextContent('Осталось 47 мин');
    expect(card).toHaveTextContent('«Обновляю ядро».');
    expect(card).toHaveTextContent('Host скрыты: 2.');
    const before = Date.parse(m.until ?? '');
    await user.click(within(card).getByRole('button', { name: '+1 час' }));
    await waitFor(() =>
      expect(Date.parse(mockRemnawave.nodes[0]?.maintenance?.until ?? '') - before).toBe(60 * 60_000),
    );
    await user.click(within(card).getByRole('button', { name: 'Закончить' }));
    await waitFor(() => expect(mockRemnawave.nodes[0]?.maintenance).toBeNull());
  });

  it('без срока — «До выключения», без «+1 час»; ошибка скрытия Host видна', () => {
    const m = running(null, {
      hosts: { hidden: [], shared: 0, error: 'Host не скрыты: нет права «Изменение Host»' },
    });
    seed(m);
    wrap(<MaintenanceCard node={NODE} m={m} />);
    const card = screen.getByRole('region', { name: 'Обслуживание ноды' });
    expect(card).toHaveTextContent('До выключения');
    expect(within(card).queryByRole('button', { name: '+1 час' })).toBeNull();
    expect(card).toHaveTextContent('Host не скрыты: нет права «Изменение Host»');
  });

  it('«осталось» словами', () => {
    const now = Date.parse('2026-10-15T09:00:00Z');
    expect(maintenanceLeft('2026-10-15T09:00:30Z', now)).toBe('меньше минуты');
    expect(maintenanceLeft('2026-10-15T09:47:00Z', now)).toBe('47 мин');
    expect(maintenanceLeft('2026-10-15T10:12:00Z', now)).toBe('1 ч 12 мин');
    expect(maintenanceLeft('2026-10-15T12:00:00Z', now)).toBe('3 ч');
  });
});

describe('нода на обслуживании в списке и «Обзоре»', () => {
  it('строка: метка «Обслуживание», пунктирная кромка, «до …» вместо «Работает», онлайн без красного', () => {
    const m = running(47);
    render(<NodeCard node={{ ...NODE, maintenance: m }} stale={false} onClick={vi.fn()} />);
    const row = screen.getByRole('button');
    expect(row).toHaveAttribute('data-state', 'maintenance');
    expect(row).toHaveTextContent('Обслуживание');
    expect(row).not.toHaveTextContent('Работает');
    expect(screen.getByTitle(/Обслуживание до \d\d:\d\d: «Обновляю ядро»/)).toBeVisible();
  });

  it('в «Обзоре» лежащая нода на обслуживании — не сбой', () => {
    expect(nodeHealth({ ...NODE, maintenance: running(10) }, [])).toBe('maintenance');
    expect(nodeHealth(NODE, [])).toBe('crit');
  });
});
