import { describe, expect, it } from 'vitest';

import { isNetworkNoise } from './network-noise.js';

describe('isNetworkNoise', () => {
  it('обрывы сети и потоков переживаем', () => {
    expect(isNetworkNoise(Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }))).toBe(true);
    expect(isNetworkNoise(Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }))).toBe(true);
    // ssh2: соединение пропало до или после входа.
    expect(
      isNetworkNoise(Object.assign(new Error('Connection lost before handshake'), { level: 'protocol' })),
    ).toBe(true);
    expect(isNetworkNoise(Object.assign(new Error('Keepalive timeout'), { level: 'client-timeout' }))).toBe(
      true,
    );
    // ws: слишком большое или битое сообщение.
    expect(
      isNetworkNoise(
        Object.assign(new RangeError('Max payload size exceeded'), {
          code: 'WS_ERR_UNSUPPORTED_MESSAGE_LENGTH',
        }),
      ),
    ).toBe(true);
  });

  it('ошибки программы не переживаем: процесс должен перезапуститься', () => {
    expect(isNetworkNoise(new TypeError("Cannot read properties of undefined (reading 'id')"))).toBe(false);
    expect(isNetworkNoise(new RangeError('Maximum call stack size exceeded'))).toBe(false);
    expect(
      isNetworkNoise(Object.assign(new Error('out of memory'), { code: 'ERR_WORKER_OUT_OF_MEMORY' })),
    ).toBe(false);
    // Отказ во входе по SSH — не обрыв: такое должно обрабатываться там, где подключаемся.
    expect(isNetworkNoise(Object.assign(new Error('auth'), { level: 'client-authentication' }))).toBe(false);
    expect(isNetworkNoise('строка')).toBe(false);
    expect(isNetworkNoise(null)).toBe(false);
  });
});
