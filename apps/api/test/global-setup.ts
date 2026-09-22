import { Client } from 'pg';

/**
 * Создаёт БД nodeservice_test, если её нет. Выполняется до загрузки тестовых файлов —
 * ConfigModule читает окружение при импорте AppModule, поэтому DATABASE_URL задаётся
 * в vitest.config.e2e.ts (test.env), а здесь только гарантируем существование БД.
 */
export const TEST_DB = 'nodeservice_test';
export const ADMIN_URL =
  process.env.E2E_ADMIN_DATABASE_URL ?? 'postgres://nodeservice:nodeservice@127.0.0.1:5432/nodeservice';

export function testDatabaseUrl(): string {
  const url = new URL(ADMIN_URL);
  url.pathname = `/${TEST_DB}`;
  return url.toString();
}

export default async function setup(): Promise<void> {
  const client = new Client({ connectionString: ADMIN_URL });
  await client.connect();
  try {
    const exists = await client.query('select 1 from pg_database where datname = $1', [TEST_DB]);
    if (exists.rowCount === 0) await client.query(`create database ${TEST_DB}`);
  } finally {
    await client.end();
  }
}
