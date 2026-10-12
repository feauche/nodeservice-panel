import type { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { eq, sql } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AppModule } from '../src/app.module.js';
import { setupHttp } from '../src/common/http/setup-http.js';
import { DB, type Db } from '../src/infra/db/db.module.js';
import { runMigrations } from '../src/infra/db/migrate.js';
import { incidents } from '../src/infra/db/schema/incidents.js';
import { VALKEY } from '../src/infra/valkey/valkey.module.js';
import { auditLog } from '../src/modules/audit/audit.table.js';
import { HousekeepingService } from '../src/modules/housekeeping/housekeeping.service.js';

const daysAgo = (d: number) => new Date(Date.now() - d * 86_400_000);

describe('housekeeping e2e — чистка по сроку хранения', () => {
  let app: INestApplication;
  let db: Db;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication<NestExpressApplication>({ bufferLogs: false, logger: false });
    setupHttp(app as NestExpressApplication);
    db = app.get<Db>(DB);
    await runMigrations(db);
    await db.execute(sql`truncate incidents cascade`);
    await app.get<Redis>(VALKEY).flushdb();
    await app.init();
  }, 60_000);

  afterAll(async () => {
    await app?.close();
  });

  it('старые решённые события удаляются, открытые и свежие остаются, итог — в Журнале', async () => {
    await db.insert(incidents).values([
      {
        serverName: 'hk-1',
        kind: 'node_down',
        severity: 'warn',
        status: 'resolved',
        title: 'old',
        openedAt: daysAgo(400),
        resolvedAt: daysAgo(400),
        resolvedBy: 'auto',
      },
      {
        serverName: 'hk-1',
        kind: 'node_down',
        severity: 'warn',
        status: 'resolved',
        title: 'recent',
        openedAt: daysAgo(30),
        resolvedAt: daysAgo(30),
        resolvedBy: 'auto',
      },
      {
        serverName: 'hk-1',
        kind: 'cpu_high',
        severity: 'warn',
        status: 'open',
        title: 'open-old',
        openedAt: daysAgo(400),
        resolvedAt: null,
      },
    ]);

    const countEntries = async () =>
      (
        await db
          .select({ id: auditLog.id })
          .from(auditLog)
          .where(eq(auditLog.action, 'system.retention.applied'))
      ).length;
    const entriesBefore = await countEntries();
    const report = await app.get(HousekeepingService).applyRetention();
    expect(report).toEqual({ incidents: 1 });

    const inc = await db.select({ t: incidents.title }).from(incidents);
    expect(inc.map((r) => r.t).sort()).toEqual(['open-old', 'recent']);

    const entries = await db
      .select({ action: auditLog.action, metadata: auditLog.metadata })
      .from(auditLog)
      .where(eq(auditLog.action, 'system.retention.applied'));
    expect(entries).toHaveLength(entriesBefore + 1);
    expect(entries.at(-1)?.metadata).toMatchObject({ incidents: 1 });

    // Повторный прогон ничего не удаляет и в Журнал не пишет
    expect(await app.get(HousekeepingService).applyRetention()).toEqual({ incidents: 0 });
    expect(await countEntries()).toBe(entriesBefore + 1);
  });
});
