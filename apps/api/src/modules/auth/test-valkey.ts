import { Redis } from 'ioredis';

/**
 * Реальный Valkey для юнит-тестов хранилищ (127.0.0.1:6379, БД 15, чтобы не задеть dev-данные).
 * Тесты делают cleanup по своим префиксам.
 */
export function testValkey(): Redis {
  return new Redis(process.env.TEST_VALKEY_URL ?? 'redis://127.0.0.1:6379/15', {
    lazyConnect: false,
    maxRetriesPerRequest: 2,
  });
}

export async function deleteByPattern(valkey: Redis, pattern: string): Promise<void> {
  const keys = await valkey.keys(pattern);
  if (keys.length > 0) await valkey.del(...keys);
}
