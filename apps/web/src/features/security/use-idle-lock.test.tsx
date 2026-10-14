import { act, waitFor } from '@testing-library/react';
import { useEffect, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useAuthStore } from '@/features/auth/store';
import { configureIdleLimit, resetActivity } from '@/lib/activity';
import { mockMe, mockState, resetMockState } from '@/test/msw/handlers';
import { renderPage } from '@/test/render';
import { useIdleLock } from './use-idle-lock';

/** Как «Обзор»: данные обновляются каждые 5 секунд, страница перерисовывается. */
function BusyPage() {
  const [, setTick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setTick((n) => n + 1), 5_000);
    return () => clearInterval(timer);
  }, []);
  useIdleLock(1);
  return <div>обзор</div>;
}

const lockedByIdle = () => {
  const st = useAuthStore.getState();
  return st.locked && st.lockInfo?.reason === 'idle';
};

describe('автоблокировка в браузере', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    resetMockState({ authenticated: true });
    useAuthStore.setState({ me: mockMe, hydrated: true, locked: false, lockInfo: null });
  });
  afterEach(() => {
    vi.useRealTimers();
    configureIdleLimit(0, null);
    Reflect.deleteProperty(document, 'visibilityState');
    act(() => useAuthStore.getState().signedOut());
  });

  it('человека нет дольше срока — экран блокируется, сервер узнаёт, что по бездействию', async () => {
    resetActivity(Date.now() - 2 * 60_000);
    const { router } = renderPage(BusyPage, '/servers', ['/lock']);
    await waitFor(() => expect(router.state.location.pathname).toBe('/lock'));
    expect(useAuthStore.getState().lockInfo).toEqual({ reason: 'idle', minutes: 1 });
    await waitFor(() => expect(mockState.lockReason).toBe('idle'));
  });

  it('перерисовки страницы не сбрасывают отсчёт: минута без действий — блокировка', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    resetActivity(Date.now() - 50_000);
    renderPage(BusyPage, '/servers', ['/lock']);
    await act(async () => {});
    expect(lockedByIdle()).toBe(false);
    await act(async () => vi.advanceTimersByTime(15_000)); // три перерисовки и проверка
    expect(lockedByIdle()).toBe(true);
  });

  it('проверка идёт и в фоновой вкладке', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    resetActivity(Date.now() - 50_000);
    renderPage(BusyPage, '/servers', ['/lock']);
    await act(async () => vi.advanceTimersByTime(15_000));
    expect(lockedByIdle()).toBe(true);
  });

  it('первое действие после сна компьютера блокирует экран, а не начинает отсчёт заново', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    resetActivity(Date.now());
    renderPage(BusyPage, '/servers', ['/lock']);
    await act(async () => {});
    vi.setSystemTime(Date.now() + 2 * 60_000); // таймеры стояли
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' }));
    });
    expect(lockedByIdle()).toBe(true);
  });

  it('пока человек что-то делает — экран не блокируется', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    resetActivity(Date.now());
    renderPage(BusyPage, '/servers', ['/lock']);
    for (let i = 0; i < 8; i += 1) {
      await act(async () => vi.advanceTimersByTime(15_000));
      act(() => {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' }));
      });
    }
    expect(useAuthStore.getState().locked).toBe(false);
  });
});
