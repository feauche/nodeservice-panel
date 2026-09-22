import type { INestApplicationContext } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { auditListQuerySchema, auditListResponseSchema } from '@nodeservice/shared';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { DB, type Db } from '../src/infra/db/db.module.js';
import { runMigrations } from '../src/infra/db/migrate.js';
import { AuditRepository } from '../src/modules/audit/audit.repository.js';
import { UsersRepository } from '../src/modules/auth/users.repository.js';
import { CliModule } from '../src/modules/cli/cli.module.js';
import { RevokeSessionsCommand } from '../src/modules/cli/commands/revoke-sessions.command.js';
import { SetupTokenCommand } from '../src/modules/cli/commands/setup-token.command.js';

if (!process.env.DATABASE_URL?.endsWith('/nodeservice_test'))
  throw new Error('e2e: DATABASE_URL должен указывать на nodeservice_test');

/** Rescue-CLI: команды меняют учётку без сессии — каждая обязана оставить след в Журнале. */
describe('cli e2e', () => {
  let app: INestApplicationContext;
  let db: Db;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [CliModule] }).compile();
    app = await moduleRef.createNestApplication({ logger: false }).init();
    db = app.get<Db>(DB);
    await runMigrations(db);
    await db.execute(sql`truncate users, recovery_codes, trusted_devices, setup_tokens cascade`);
  }, 60_000);

  afterAll(async () => {
    await app?.close();
  });

  it('setup-token и revoke-sessions пишут в Журнал от имени rescue-CLI', async () => {
    const log: string[] = [];
    const orig = console.log;
    console.log = (...a: unknown[]) => log.push(a.join(' '));
    try {
      await app.get(SetupTokenCommand).run();
      await app.get(RevokeSessionsCommand).run([]);
    } finally {
      console.log = orig;
    }
    expect(log.join('\n')).toContain('токен');
    const page = auditListResponseSchema.parse(
      await app.get(AuditRepository).list(auditListQuerySchema.parse({ pageSize: 50 })),
    );
    const token = page.items.find((e) => e.action === 'auth.setup_token.issued');
    const revoked = page.items.find((e) => e.action === 'security.cli.sessions_revoked');
    expect(token).toMatchObject({
      actorType: 'system',
      actorDisplay: 'rescue-CLI',
      source: 'manual',
      result: 'ok',
    });
    expect(revoked).toMatchObject({ actorType: 'system', actorDisplay: 'rescue-CLI', severity: 'warn' });
    expect(revoked?.metadata).toMatchObject({ scope: 'all', sessionsRevoked: 0 });
    expect(await app.get(UsersRepository).listUsers()).toHaveLength(0);
  });
});
