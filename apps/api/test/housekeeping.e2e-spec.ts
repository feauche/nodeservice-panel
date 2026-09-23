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
import { maintenanceRuns, servers, terminalSessions } from '../src/infra/db/schema/servers.js';
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
    await db.execute(sql`truncate servers, incidents cascade`);
    await app.get<Redis>(VALKEY).flushdb();
    await app.init();
  }, 60_000);

  afterAll(async () => {
    await app?.close();
  });

  it('старые записи удаляются, живые и свежие остаются, итог — в Журнале', async () => {
    const [srv] = await db
      .insert(servers)
      .values({ name: 'hk-1', host: '203.0.113.9', sshUser: 'root' })
      .returning({ id: servers.id });
    if (!srv) throw new Error('server');
    await db.insert(terminalSessions).values([
      { serverId: srv.id, startedAt: daysAgo(120), endedAt: daysAgo(120), transcript: 'old' },
      { serverId: srv.id, startedAt: daysAgo(10), endedAt: daysAgo(10), transcript: 'fresh' },
      { serverId: srv.id, startedAt: daysAgo(200), endedAt: null, transcript: 'live' },
    ]);
    await db.insert(maintenanceRuns).values([
      { serverId: srv.id, kind: 'check', status: 'ok', startedAt: daysAgo(100), finishedAt: daysAgo(100) },
      { serverId: srv.id, kind: 'check', status: 'ok', startedAt: daysAgo(1), finishedAt: daysAgo(1) },
      { serverId: srv.id, kind: 'apt_upgrade', status: 'running', startedAt: daysAgo(100), finishedAt: null },
    ]);
    await db.insert(incidents).values([
      {
        serverId: srv.id,
        serverName: 'hk-1',
        kind: 'disk_high',
        severity: 'warn',
        status: 'resolved',
        title: 'old',
        openedAt: daysAgo(400),
        resolvedAt: daysAgo(400),
        resolvedBy: 'auto',
      },
      {
        serverId: srv.id,
        serverName: 'hk-1',
        kind: 'disk_high',
        severity: 'warn',
        status: 'resolved',
        title: 'recent',
        openedAt: daysAgo(30),
        resolvedAt: daysAgo(30),
        resolvedBy: 'auto',
      },
      {
        serverId: srv.id,
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
    expect(report).toEqual({ terminalSessions: 1, maintenanceRuns: 1, incidents: 1 });

    const term = await db.select({ t: terminalSessions.transcript }).from(terminalSessions);
    expect(term.map((r) => r.t).sort()).toEqual(['fresh', 'live']);
    const maint = await db
      .select({ s: maintenanceRuns.status, k: maintenanceRuns.kind })
      .from(maintenanceRuns);
    expect(maint).toHaveLength(2);
    expect(maint.some((r) => r.s === 'running')).toBe(true);
    const inc = await db.select({ t: incidents.title }).from(incidents);
    expect(inc.map((r) => r.t).sort()).toEqual(['open-old', 'recent']);

    const entries = await db
      .select({ action: auditLog.action, metadata: auditLog.metadata })
      .from(auditLog)
      .where(eq(auditLog.action, 'system.retention.applied'));
    expect(entries).toHaveLength(entriesBefore + 1);
    expect(entries.at(-1)?.metadata).toMatchObject({ terminalSessions: 1, maintenanceRuns: 1, incidents: 1 });

    // Повторный прогон ничего не удаляет и в Журнал не пишет
    expect(await app.get(HousekeepingService).applyRetention()).toEqual({
      terminalSessions: 0,
      maintenanceRuns: 0,
      incidents: 0,
    });
    expect(await countEntries()).toBe(entriesBefore + 1);
  });
});
