import type { RemnawaveStatus } from '@nodeservice/shared';
import { QueryClient, QueryObserver } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { remnawaveApi, remnawaveStatusQuery } from './remnawave-api';

const STATUS: RemnawaveStatus = {
  connected: true,
  domain: 'vpn-panel.example.com',
  checkedAt: '2026-09-30T10:00:00.000Z',
  error: null,
  stats: null,
  nodes: [],
  cert: null,
};

describe('статус Remnawave', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('перечитывается раз в минуту, пока открыт: пилюли на карточках не остаются с данными момента открытия', async () => {
    vi.useFakeTimers();
    const fetchStatus = vi.spyOn(remnawaveApi, 'status').mockResolvedValue(STATUS);
    const qc = new QueryClient();
    const unsubscribe = new QueryObserver(qc, remnawaveStatusQuery).subscribe(() => {});
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchStatus).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(59_000);
    expect(fetchStatus).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fetchStatus).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchStatus).toHaveBeenCalledTimes(3);
    unsubscribe();
    qc.clear();
  });
});
