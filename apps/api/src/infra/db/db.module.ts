import { Global, Inject, Logger, Module, type OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';

import type { Env } from '../../config/env.schema.js';
import * as schema from './schema/index.js';

export type Db = NodePgDatabase<typeof schema>;
export const DB = Symbol('DB');
export const PG_POOL = Symbol('PG_POOL');

/**
 * Пул соединений. Слушатель 'error' обязателен: обрыв простаивающего соединения (базу перезапустили или
 * подменили при восстановлении из копии) пул сообщает событием, и без слушателя оно роняет весь процесс —
 * при восстановлении это случалось посреди подмены базы. Оборванное соединение пул выбросит и откроет новое.
 */
export function createPool(connectionString: string): Pool {
  const pool = new Pool({
    connectionString,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    application_name: 'nodeservice-api',
  });
  const log = new Logger('Postgres');
  pool.on('error', (err) => log.warn(`Соединение с базой оборвалось: ${err.message}`));
  return pool;
}

@Global()
@Module({
  providers: [
    {
      provide: PG_POOL,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) => createPool(config.get('DATABASE_URL')),
    },
    {
      provide: DB,
      inject: [PG_POOL],
      useFactory: (pool: Pool): Db => drizzle(pool, { schema, casing: 'snake_case' }),
    },
  ],
  exports: [DB, PG_POOL],
})
export class DbModule implements OnApplicationShutdown {
  private readonly log = new Logger(DbModule.name);

  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async onApplicationShutdown(): Promise<void> {
    await this.pool.end();
    this.log.log('Пул соединений PostgreSQL закрыт');
  }
}
