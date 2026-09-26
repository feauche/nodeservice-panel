import type { Server } from '@nodeservice/shared';
import { render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';

import { TooltipProvider } from '@/components/ui/tooltip';
import { resetMockState } from '@/test/msw/handlers';
import { mockServers, seedServers } from '@/test/msw/servers-mock';
import { renderPage } from '@/test/render';
import { DriftDot, RoleMark, roleMarkLabel } from './server-marks';
import { ServersPage } from './servers-page';

const base = (over: Partial<Server> = {}): Server =>
  ({
    id: '11111111-1111-4111-8111-111111111111',
    name: 'ru-entry-1',
    profile: {
      roles: [],
      importance: 'normal',
      maintenanceWindow: null,
      expectedContainers: [],
      expectedPorts: [],
    },
    drift: [],
    ...over,
  }) as Server;

const withProfile = (p: Partial<Server['profile']>, drift: Server['drift'] = []) =>
  base({ profile: { ...base().profile, ...p }, drift });

const wrap = (ui: React.ReactNode) => render(<TooltipProvider delayDuration={0}>{ui}</TooltipProvider>);

describe('значок функций (B3)', () => {
  it('одна функция и критичность: значок с подписью «Вход. Критичный»', () => {
    wrap(<RoleMark server={withProfile({ roles: ['entry'], importance: 'critical' })} />);
    expect(screen.getByRole('img', { name: 'Вход. Критичный' })).toBeInTheDocument();
  });

  it('у каждой функции свой значок и своя подпись', () => {
    const labels: Array<[Server['profile']['roles'][number], string]> = [
      ['entry', 'Вход. Обычный'],
      ['exit', 'Выход. Обычный'],
      ['bridge', 'Мост. Обычный'],
      ['panel', 'Панель. Обычный'],
      ['other', 'Другое. Обычный'],
    ];
    const seen = new Set<string>();
    for (const [role, label] of labels) {
      const { container, unmount } = wrap(<RoleMark server={withProfile({ roles: [role] })} />);
      expect(screen.getByRole('img', { name: label })).toBeInTheDocument();
      seen.add(container.querySelector('svg')?.innerHTML ?? '');
      unmount();
    }
    expect(seen.size).toBe(5);
  });

  it('несколько функций: общий значок и перечисление в подписи', () => {
    const { container, unmount } = wrap(
      <RoleMark server={withProfile({ roles: ['entry', 'exit'], importance: 'critical' })} />,
    );
    expect(screen.getByRole('img', { name: 'Вход, Выход. Критичный' })).toBeInTheDocument();
    const multi = container.querySelector('svg')?.innerHTML ?? '';
    unmount();
    for (const role of ['entry', 'exit', 'bridge', 'panel', 'other'] as const) {
      const one = wrap(<RoleMark server={withProfile({ roles: [role] })} />);
      expect(one.container.querySelector('svg')?.innerHTML).not.toBe(multi);
      one.unmount();
    }
  });

  it('без функций: значок только у критичного, с подписью «Важность: Критичный»', () => {
    wrap(<RoleMark server={withProfile({ roles: [], importance: 'critical' })} />);
    expect(screen.getByRole('img', { name: 'Важность: Критичный' })).toBeInTheDocument();
  });

  it('без функций и без критичности значка нет', () => {
    for (const importance of ['normal', 'low'] as const) {
      const { container, unmount } = wrap(<RoleMark server={withProfile({ importance })} />);
      expect(container).toBeEmptyDOMElement();
      expect(roleMarkLabel(withProfile({ importance }).profile)).toBeNull();
      unmount();
    }
  });
});

describe('точка расхождения (B3)', () => {
  const drift: Server['drift'] = [
    { kind: 'container_not_running', subject: 'nginx', detail: 'Контейнер «nginx» не работает.' },
    { kind: 'port_not_listening', subject: '8443', detail: 'Порт 8443 никто не слушает.' },
  ];
  it('при расхождениях точка с числом в подписи', () => {
    wrap(<DriftDot server={withProfile({}, drift)} />);
    expect(screen.getByRole('img', { name: 'Не совпадает с ожидаемым: 2' })).toBeInTheDocument();
  });
  it('без расхождений точки нет', () => {
    const { container } = wrap(<DriftDot server={withProfile({})} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe('карточки в сетке', () => {
  beforeEach(() => {
    resetMockState({ authenticated: true });
    seedServers();
  });

  it('значок и точка только у сервера с профилем; у остальных карточек их нет', async () => {
    const first = mockServers.items[0] as Server;
    mockServers.items[0] = {
      ...first,
      profile: { ...first.profile, roles: ['entry'], importance: 'critical' },
      drift: [{ kind: 'port_not_listening', subject: '8443', detail: 'Порт 8443 никто не слушает.' }],
    };
    renderPage(() => <ServersPage tag={undefined} onTag={() => {}} />, '/servers');
    await screen.findByText(first.name);
    const cards = screen.getAllByRole('article');
    const mine = cards.find((c) => within(c).queryByText(first.name)) as HTMLElement;
    expect(within(mine).getByRole('img', { name: 'Вход. Критичный' })).toBeInTheDocument();
    expect(within(mine).getByRole('img', { name: 'Не совпадает с ожидаемым: 1' })).toBeInTheDocument();
    for (const other of cards.filter((c) => c !== mine)) {
      expect(within(other).queryByTestId('role-mark')).toBeNull();
      expect(within(other).queryByTestId('drift-dot')).toBeNull();
    }
  });
});
