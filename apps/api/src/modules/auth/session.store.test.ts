import type { ConfigService } from '@nestjs/config';
import { SECURITY_POLICY_DEFAULTS } from '@nodeservice/shared';
import type { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { CryptoService } from '../../common/crypto/crypto.service.js';
import type { Env } from '../../config/env.schema.js';
import type { SecurityPolicyStore } from './security-policy.store.js';
import { SessionStore } from './session.store.js';
import { deleteByPattern, testValkey } from './test-valkey.js';

const values: Partial<Env> = {
  APP_SECRET: 'test-app-secret-0123456789abcdef',
  ENCRYPTION_KEY: 'ab'.repeat(32),
  ENCRYPTION_KEY_VERSION: 1,
  SESSION_IDLE_MINUTES: 30,
  SESSION_ABSOLUTE_HOURS: 12,
  TRUSTED_SESSION_ABSOLUTE_HOURS: 168,
};
const config = { get: (k: keyof Env) => values[k] } as unknown as ConfigService<Env, true>;
// Политика безопасности в юнит-тесте — дефолтная (idle 360 мин и т.д.), без БД.
const policy = {
  // idle из политики должен совпадать с ожиданиями теста (30 мин), а не с дефолтом 360
  get: async () => ({ ...SECURITY_POLICY_DEFAULTS, idleMinutes: 30 }),
} as unknown as SecurityPolicyStore;

describe('SessionStore (Valkey)', () => {
  let valkey: Redis;
  let store: SessionStore;
  const userId = 'test-user-sessions';

  beforeAll(async () => {
    valkey = testValkey();
    store = new SessionStore(valkey, new CryptoService(config), policy, config);
    await deleteByPattern(valkey, `user:${userId}:*`);
  });
  afterAll(async () => {
    await store.destroyAllForUser(userId);
    await valkey.quit();
  });

  it('create → get/touch → destroy', async () => {
    const s = await store.create({ userId, ua: 'vitest', ip: '127.0.0.1', amr: ['pwd', 'totp'] });
    expect(s.id).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(s.stepUpAt).toBe(s.createdAt);

    const got = await store.get(s.id);
    expect(got).toMatchObject({ userId, amr: ['pwd', 'totp'], ua: 'vitest' });

    const ttl = await valkey.pttl(`sess:${s.id}`);
    expect(ttl).toBeGreaterThan(29 * 60_000);
    expect(ttl).toBeLessThanOrEqual(30 * 60_000);

    const touched = await store.touch(s.id);
    expect(touched?.lastSeenAt).toBeDefined();
    expect(await valkey.sismember(`user:${userId}:sessions`, s.id)).toBe(1);

    await store.destroy(s.id);
    expect(await store.get(s.id)).toBeNull();
    expect(await store.touch(s.id)).toBeNull();
    // touch не воскрешает удалённый ключ
    expect(await valkey.exists(`sess:${s.id}`)).toBe(0);
    expect(await valkey.sismember(`user:${userId}:sessions`, s.id)).toBe(0);
  });

  it('trusted-сессия живёт дольше, listForUser и destroyAllForUser', async () => {
    const a = await store.create({ userId, ua: 'a', ip: '1.1.1.1', amr: ['pwd', 'trusted'] });
    const b = await store.create({ userId, ua: 'b', ip: '2.2.2.2', amr: ['pwd', 'recovery'] });
    expect(Date.parse(a.absoluteExpiresAt) - Date.parse(a.createdAt)).toBe(168 * 3_600_000);
    expect(Date.parse(b.absoluteExpiresAt) - Date.parse(b.createdAt)).toBe(12 * 3_600_000);

    const list = await store.listForUser(userId);
    expect(list.map((s) => s.id).sort()).toEqual([a.id, b.id].sort());

    expect(await store.destroyAllForUser(userId)).toBe(2);
    expect(await store.listForUser(userId)).toEqual([]);
  });

  it('setStepUp обновляет метку; мусорный sid → null', async () => {
    const s = await store.create({ userId, ua: 'x', ip: '::1', amr: ['pwd'] });
    const at = new Date('2030-01-01T00:00:00.000Z');
    await store.setStepUp(s.id, at);
    expect((await store.get(s.id))?.stepUpAt).toBe(at.toISOString());
    expect(await store.get('../../etc')).toBeNull();
    expect(await store.get('')).toBeNull();
  });
});
