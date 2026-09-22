import { QueryClient } from '@tanstack/react-query';
import { isRedirect } from '@tanstack/react-router';
import { describe, expect, it } from 'vitest';

import { resetMockState } from '@/test/msw/handlers';
import { requireAuth, requireGuest, requireLocked, requirePendingTotp, requireSetup } from './guards';
import { useAuthStore } from './store';

type Guard = (ctx: { queryClient: QueryClient }) => Promise<void>;

/** Куда ушёл редирект; null — guard пропустил. */
async function redirectOf(guard: Guard): Promise<string | null> {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  try {
    await guard({ queryClient });
    return null;
  } catch (e) {
    if (isRedirect(e)) return String(e.options.to);
    throw e;
  }
}

interface Scenario {
  name: string;
  state: { setupRequired?: boolean; authenticated?: boolean; locked?: boolean; pendingTotp?: boolean };
  expect: Record<'auth' | 'guest' | 'pending' | 'setup' | 'locked', string | null>;
}

const MATRIX: Scenario[] = [
  {
    name: 'нужен первый запуск',
    state: { setupRequired: true },
    expect: { auth: '/setup', guest: '/setup', pending: '/setup', setup: null, locked: '/setup' },
  },
  {
    name: 'гость',
    state: {},
    expect: { auth: '/login', guest: null, pending: '/login', setup: '/login', locked: '/login' },
  },
  {
    name: 'гость, пароль принят (pendingTotp)',
    state: { pendingTotp: true },
    expect: { auth: '/login', guest: null, pending: null, setup: '/login', locked: '/login' },
  },
  {
    name: 'сессия есть',
    state: { authenticated: true },
    expect: { auth: null, guest: '/', pending: '/', setup: '/', locked: '/' },
  },
  {
    name: 'сессия есть, экран заблокирован',
    state: { authenticated: true, locked: true },
    expect: { auth: '/lock', guest: '/lock', pending: '/lock', setup: '/', locked: null },
  },
];

describe('guards', () => {
  for (const sc of MATRIX) {
    it(sc.name, async () => {
      resetMockState({
        setupRequired: sc.state.setupRequired ?? false,
        authenticated: sc.state.authenticated ?? false,
      });
      useAuthStore.setState({ me: null, hydrated: false, locked: false, pendingTotp: false });
      if (sc.state.locked) useAuthStore.getState().lock();
      if (sc.state.pendingTotp) useAuthStore.getState().setPendingTotp(true);

      expect(await redirectOf(requireAuth), 'requireAuth').toBe(sc.expect.auth);
      expect(await redirectOf(requireGuest), 'requireGuest').toBe(sc.expect.guest);
      expect(await redirectOf(requirePendingTotp), 'requirePendingTotp').toBe(sc.expect.pending);
      expect(await redirectOf(requireSetup), 'requireSetup').toBe(sc.expect.setup);
      expect(await redirectOf(requireLocked), 'requireLocked').toBe(sc.expect.locked);
    });
  }

  it('после hydrate стор знает me и recoveryCodesLeft', async () => {
    resetMockState({ authenticated: true, recoveryLeft: 3 });
    useAuthStore.setState({ me: null, hydrated: false, locked: false, recoveryCodesLeft: null });
    await redirectOf(requireAuth);
    const st = useAuthStore.getState();
    expect(st.hydrated).toBe(true);
    expect(st.me?.login).toBe('admin');
    expect(st.recoveryCodesLeft).toBe(3);
  });

  it('гость: locked-флаг сбрасывается (сессии нет — блокировать нечего)', async () => {
    resetMockState();
    useAuthStore.setState({ me: null, hydrated: false, locked: false });
    useAuthStore.getState().lock();
    expect(await redirectOf(requireGuest)).toBe(null);
    expect(useAuthStore.getState().locked).toBe(false);
    expect(sessionStorage.getItem('ns-locked')).toBeNull();
  });
});
