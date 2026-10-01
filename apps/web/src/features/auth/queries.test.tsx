import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook } from '@testing-library/react';
import { HttpResponse, http } from 'msw';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { mockMe } from '@/test/msw/handlers';
import { server } from '@/test/msw/server';
import { SESSION_WATCH_INTERVAL_MS, useSessionWatch } from './queries';
import { useAuthStore } from './store';

describe('useSessionWatch', () => {
  afterEach(() => {
    vi.useRealTimers();
    useAuthStore.getState().signedOut();
  });

  it('панель на экране раз в минуту обращается к серверу — так и продлевается сессия («Политика»)', async () => {
    // Подделываем только интервал опроса: запросы и ответы мока идут своим ходом.
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    let asked = 0;
    server.use(
      http.get('/api/auth/status', () => {
        asked += 1;
        return HttpResponse.json({ setupRequired: false, authenticated: true, locked: false });
      }),
    );
    useAuthStore.getState().setMe(mockMe);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    renderHook(() => useSessionWatch({ navigate: async () => undefined }), {
      wrapper: ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={qc}>{children}</QueryClientProvider>
      ),
    });
    await vi.waitFor(() => expect(asked).toBe(1));

    for (let minute = 1; minute <= 3; minute += 1) {
      vi.advanceTimersByTime(SESSION_WATCH_INTERVAL_MS);
      await vi.waitFor(() => expect(asked).toBe(1 + minute));
    }
    // Самый короткий срок «Завершать сессию при бездействии» — 15 минут: опрос раз в минуту с запасом.
    expect(SESSION_WATCH_INTERVAL_MS).toBeLessThanOrEqual(60_000);
  });
});
