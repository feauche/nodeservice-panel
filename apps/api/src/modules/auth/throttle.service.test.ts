import { HttpException } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { deleteByPattern, testValkey } from './test-valkey.js';
import { SERIES_MEMORY_SECONDS, ThrottleService } from './throttle.service.js';

describe('ThrottleService (Valkey)', () => {
  let valkey: Redis;
  let svc: ThrottleService;
  const key = { ip: '203.0.113.7', login: 'Throttle-Test' };

  beforeAll(async () => {
    valkey = testValkey();
    svc = new ThrottleService(valkey);
    await deleteByPattern(valkey, 'throttle:*');
  });
  afterAll(async () => {
    await deleteByPattern(valkey, 'throttle:*');
    await valkey.quit();
  });

  it('4 неудачи — свободно, 5-я включает паузу 30 с, потом 429 с retryAfterSeconds', async () => {
    await svc.reset(key);
    for (let i = 0; i < 4; i++) {
      await svc.recordFailure(key);
      await svc.assertAllowed(key);
    }
    const err = await svc.recordFailure(key).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpException);
    const body = (err as HttpException).getResponse() as { extensions: { retryAfterSeconds: number } };
    expect((err as HttpException).getStatus()).toBe(429);
    expect(body.extensions.retryAfterSeconds).toBeLessThanOrEqual(30);
    expect(body.extensions.retryAfterSeconds).toBeGreaterThan(25);

    await expect(svc.assertAllowed(key)).rejects.toBeInstanceOf(HttpException);
    // логин — регистронезависимый, IP — отдельный ключ
    await expect(svc.assertAllowed({ ip: '198.51.100.1', login: 'throttle-test' })).rejects.toThrow();
    await expect(svc.assertAllowed({ ip: '198.51.100.1', login: 'someone-else' })).resolves.toBeUndefined();
    expect(await svc.currentSeries('login', key.login)).toBe(1);
    // память о серии — час (не сутки): после часа тишины расписание начинается с 30 с
    expect(SERIES_MEMORY_SECONDS).toBe(3600);
    const ttl = await valkey.ttl('throttle:series:login:throttle-test');
    expect(ttl).toBeGreaterThan(3500);
    expect(ttl).toBeLessThanOrEqual(3600);
  });

  it('успех сбрасывает счётчики и серии', async () => {
    await svc.reset(key);
    await expect(svc.assertAllowed(key)).resolves.toBeUndefined();
    expect(await svc.currentSeries('ip', key.ip)).toBe(0);
  });
});
