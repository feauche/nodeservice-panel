import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it } from 'vitest';

import { resetMockState } from '@/test/msw/handlers';
import { mockServers, mockTerminalSessions } from '@/test/msw/servers-mock';
import { useTerminalSession } from './terminal-api';

const SID = '22222222-2222-4222-8222-222222222222';

/** Живая (ещё не завершённая) сессия первого сервера мока с заданной записью. */
function liveSession(transcript: string): string {
  const serverId = mockServers.items[0]?.id ?? '';
  mockTerminalSessions.items = [
    {
      id: SID,
      serverId,
      actorDisplay: 'admin',
      startedAt: new Date(Date.now() - 60_000).toISOString(),
      endedAt: null,
      cols: 120,
      rows: 30,
      bytesOut: 64,
      truncated: false,
      exitCode: null,
      endReason: null,
    },
  ];
  mockTerminalSessions.transcripts = { [SID]: transcript };
  return serverId;
}

function renderSession(serverId: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  const hook = renderHook(() => useTerminalSession(serverId, SID), { wrapper });
  /**
   * Очередная догрузка (как по таймеру живой сессии) — запись из её результата: хук узнаёт о новых
   * данных чуть позже (уведомления React Query идут отдельной задачей), и result.current отставал бы.
   */
  const refetch = async (): Promise<string | undefined> => {
    let text: string | undefined;
    await act(async () => {
      text = (await hook.result.current.refetch()).data?.transcript;
    });
    return text;
  };
  return { ...hook, refetch };
}

describe('useTerminalSession: догрузка живой сессии по смещению', () => {
  beforeEach(() => resetMockState({ authenticated: true }));

  it('запись с эмодзи: повторный запрос не делает её пустой, новый вывод приклеивается без потерь', async () => {
    const serverId = liveSession('Готово 🎉\r\nroot@de-fra-01:~# ');
    const { result, refetch } = renderSession(serverId);
    await waitFor(() => expect(result.current.data?.transcript).toBe('Готово 🎉\r\nroot@de-fra-01:~# '));

    // Нового вывода нет — запись та же (раньше смещение в единицах UTF-16 обгоняло сервер и запись пустела).
    expect(await refetch()).toBe('Готово 🎉\r\nroot@de-fra-01:~# ');
    expect(await refetch()).toBe('Готово 🎉\r\nroot@de-fra-01:~# ');

    // Новый вывод — хвост приклеивается целиком (раньше пропадало столько символов, сколько эмодзи выше).
    mockTerminalSessions.transcripts[SID] += 'apt upgrade 🚀\r\n';
    expect(await refetch()).toBe('Готово 🎉\r\nroot@de-fra-01:~# apt upgrade 🚀\r\n');
    mockTerminalSessions.transcripts[SID] += 'ok';
    expect(await refetch()).toBe('Готово 🎉\r\nroot@de-fra-01:~# apt upgrade 🚀\r\nok');
  });

  it('на сервере записи меньше, чем у нас (пересоздана), — перечитываем целиком, а не показываем пустую', async () => {
    const serverId = liveSession('первая запись\r\n');
    const { result, refetch } = renderSession(serverId);
    await waitFor(() => expect(result.current.data?.transcript).toBe('первая запись\r\n'));

    mockTerminalSessions.transcripts[SID] = 'новая';
    expect(await refetch()).toBe('новая');
    mockTerminalSessions.transcripts[SID] += ' запись';
    expect(await refetch()).toBe('новая запись');
  });
});
