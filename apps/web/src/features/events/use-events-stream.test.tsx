import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useEventsStream } from './use-events-stream';

class EventSourceStub {
  static instances: EventSourceStub[] = [];
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  readonly listeners = new Map<string, EventListener>();
  closed = false;
  readonly url: string;
  readonly options: EventSourceInit | undefined;

  constructor(url: string, options?: EventSourceInit) {
    this.url = url;
    this.options = options;
    EventSourceStub.instances.push(this);
  }

  addEventListener(type: string, listener: EventListener) {
    this.listeners.set(type, listener);
  }

  close() {
    this.closed = true;
  }
}

describe('useEventsStream', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    EventSourceStub.instances = [];
    vi.stubGlobal('EventSource', EventSourceStub);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('переподключается после обрыва и перечитывает данные после восстановления API', () => {
    const client = new QueryClient();
    const invalidate = vi.spyOn(client, 'invalidateQueries').mockResolvedValue();
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    const hook = renderHook(() => useEventsStream(), { wrapper });

    expect(EventSourceStub.instances).toHaveLength(1);
    act(() => EventSourceStub.instances[0]?.onopen?.());
    expect(invalidate).not.toHaveBeenCalled();

    act(() => EventSourceStub.instances[0]?.onerror?.());
    expect(EventSourceStub.instances[0]?.closed).toBe(true);
    act(() => vi.advanceTimersByTime(1_000));
    expect(EventSourceStub.instances).toHaveLength(2);
    act(() => EventSourceStub.instances[1]?.onopen?.());
    expect(invalidate).toHaveBeenCalledTimes(4);

    hook.unmount();
    expect(EventSourceStub.instances[1]?.closed).toBe(true);
  });
});
