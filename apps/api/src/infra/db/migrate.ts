import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Logger } from '@nestjs/common';
import { migrate } from 'drizzle-orm/node-postgres/migrator';

import type { Db } from './db.module.js';

/**
 * Применяет миграции Drizzle при старте (папка drizzle/migrations рядом с dist/).
 * В проде это единственный способ обновить схему — образ самодостаточен.
 */
export async function runMigrations(db: Db): Promise<void> {
  const log = new Logger('Migrations');
  const here = dirname(fileURLToPath(import.meta.url));
  // dist/infra/db → ../../../drizzle/migrations ; src/infra/db → ../../../drizzle/migrations
  const migrationsFolder = join(here, '..', '..', '..', 'drizzle', 'migrations');
  const started = performance.now();
  await migrate(db, { migrationsFolder });
  log.log(`Миграции применены (${Math.round(performance.now() - started)} мс)`);
}
