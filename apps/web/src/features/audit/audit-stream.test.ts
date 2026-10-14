import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useAuditStream } from './audit-api';

/** Управляемый EventSource: тест сам открывает соединение и «роняет» его, как браузер после 502. */
class FakeEventSource {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  static instances: FakeEventSource[] = [];
  readyState = FakeEventSource.CONNECTING;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  readonly url: string;
  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }
  addEventListener(): void {}
  close(): void {
    this.readyState = FakeEventSource.CLOSED;
  }
  open(): void {
    this.readyState = FakeEventSource.OPEN;
    this.onopen?.();
  }
  /** Сервер ответил не 200 — браузер закрыл соединение насовсем. */
  giveUp(): void {
    this.readyState = FakeEventSource.CLOSED;
    this.onerror?.();
  }
}

describe('живая лента Журнала после перезапуска панели', () => {
  beforeEach(() => {
    FakeEventSource.instances = [];
    vi.stubGlobal('EventSource', FakeEventSource);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('браузер сдался — подключаемся сами с паузой и перечитываем список', () => {
    const onResync = vi.fn();
    const { result } = renderHook(() => useAuditStream(true, () => {}, onResync));
    act(() => FakeEventSource.instances[0]?.open());
    expect(result.current.status).toBe('live');

    act(() => FakeEventSource.instances[0]?.giveUp());
    expect(result.current.status).toBe('waiting');
    expect(result.current.retryAt).toBe(Date.now() + 2_000);

    act(() => vi.advanceTimersByTime(2_000));
    expect(FakeEventSource.instances).toHaveLength(2);
    act(() => FakeEventSource.instances[1]?.open());
    expect(result.current.status).toBe('live');
    expect(onResync).toHaveBeenCalledTimes(1);
  });

  it('пауза растёт, «Повторить» подключает сразу', () => {
    const { result } = renderHook(() => useAuditStream(true, () => {}));
    act(() => FakeEventSource.instances[0]?.giveUp());
    act(() => vi.advanceTimersByTime(2_000));
    act(() => FakeEventSource.instances[1]?.giveUp());
    expect(result.current.retryAt).toBe(Date.now() + 5_000);
    act(() => result.current.retry());
    expect(FakeEventSource.instances).toHaveLength(3);
  });
});
