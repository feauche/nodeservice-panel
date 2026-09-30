import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { INestApplicationContext } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { auditListQuerySchema, auditListResponseSchema } from '@nodeservice/shared';
import { sql } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { CryptoService } from '../src/common/crypto/crypto.service.js';
import { DB, type Db } from '../src/infra/db/db.module.js';
import { runMigrations } from '../src/infra/db/migrate.js';
import { VALKEY } from '../src/infra/valkey/valkey.module.js';
import { AuditRepository } from '../src/modules/audit/audit.repository.js';
import { deleteByPattern } from '../src/modules/auth/test-valkey.js';
import { SECOND_FACTOR_LIMIT, ThrottleService } from '../src/modules/auth/throttle.service.js';
import { UsersRepository } from '../src/modules/auth/users.repository.js';
import { CliModule } from '../src/modules/cli/cli.module.js';
import { ResetPasswordCommand } from '../src/modules/cli/commands/reset-password.command.js';
import { RevokeSessionsCommand } from '../src/modules/cli/commands/revoke-sessions.command.js';
import { SetupTokenCommand } from '../src/modules/cli/commands/setup-token.command.js';
import { UnblockLoginCommand } from '../src/modules/cli/commands/unblock-login.command.js';

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

  /** Что команда напечатала в консоль. */
  const printed = async (run: () => Promise<void>): Promise<string> => {
    const log: string[] = [];
    const orig = console.log;
    console.log = (...a: unknown[]) => log.push(a.join(' '));
    try {
      await run();
    } finally {
      console.log = orig;
    }
    return log.join('\n');
  };
  /** Пять неудач подряд — пауза по адресу и по логину. */
  const pause = async (key: { ip: string; login: string }): Promise<void> => {
    const throttle = app.get(ThrottleService);
    for (let i = 0; i < 4; i++) await throttle.recordFailure(key);
    await expect(throttle.recordFailure(key)).rejects.toThrow();
    await expect(throttle.assertAllowed(key)).rejects.toThrow();
  };
  const lastEntry = async (action: string) =>
    auditListResponseSchema
      .parse(await app.get(AuditRepository).list(auditListQuerySchema.parse({ pageSize: 50 })))
      .items.find((e) => e.action === action);

  it('unblock-login снимает паузы входа и оставляет запись в Журнале', async () => {
    const throttle = app.get(ThrottleService);
    await deleteByPattern(app.get<Redis>(VALKEY), 'throttle:*');
    const key = { ip: '203.0.113.50', login: 'cli-paused' };
    await pause(key);

    const out = await printed(() => app.get(UnblockLoginCommand).run());
    expect(out).toContain('Паузы входа сняты: 2');
    await expect(throttle.assertAllowed(key)).resolves.toBeUndefined();
    expect(await throttle.currentSeries('login', key.login)).toBe(0);
    const entry = await lastEntry('security.cli.login_unblocked');
    expect(entry).toMatchObject({ actorType: 'system', actorDisplay: 'rescue-CLI', severity: 'warn' });
    expect(entry?.metadata).toMatchObject({ note: 'Снято пауз: 2' });

    // снимать нечего — так и говорим, а не «снято»
    expect(await printed(() => app.get(UnblockLoginCommand).run())).toContain('Пауз входа сейчас нет');
  });

  it('reset-password снимает паузы: после аварийной смены пароля можно входить сразу', async () => {
    const throttle = app.get(ThrottleService);
    const crypto = app.get(CryptoService);
    const users = app.get(UsersRepository);
    await deleteByPattern(app.get<Redis>(VALKEY), 'throttle:*');
    await users.createConfirmedAdmin({
      login: 'cli-owner',
      passwordHash: await crypto.hashPassword('forgotten old passphrase'),
      totpSecretEnc: crypto.encrypt('JBSWY3DPEHPK3PXP'),
      totpKeyVersion: crypto.currentKeyVersion,
      confirmedAt: new Date(),
      recoveryCodes: [],
    });
    // Владелец забыл пароль и перебирал варианты: пауза по логину и адресу; код из приложения тоже закрыт.
    const key = { ip: '203.0.113.51', login: 'cli-owner' };
    await pause(key);
    for (let i = 0; i < SECOND_FACTOR_LIMIT; i++) await throttle.secondFactorFailure(key.login);
    expect(await throttle.secondFactorClosedSeconds(key.login)).toBeGreaterThan(0);

    const dir = await mkdtemp(join(tmpdir(), 'ns-cli-'));
    try {
      const file = join(dir, 'password');
      await writeFile(file, 'brand new long passphrase\n');
      const out = await printed(() =>
        app.get(ResetPasswordCommand).run(['cli-owner'], { passwordFile: file }),
      );
      expect(out).toContain('Пароль для «cli-owner» обновлён');
      expect(out).toContain('Паузы входа сняты');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
    await expect(throttle.assertAllowed(key)).resolves.toBeUndefined();
    expect(await throttle.secondFactorClosedSeconds(key.login)).toBe(0);
    const user = await users.findByLogin('cli-owner');
    expect(await crypto.verifyPassword(user?.passwordHash ?? '', 'brand new long passphrase')).toBe(true);
    const entry = await lastEntry('security.cli.password_reset');
    expect(entry?.metadata).toMatchObject({ sessionsRevoked: 0, note: 'Паузы входа сняты' });
    await db.execute(sql`truncate users, recovery_codes, trusted_devices, setup_tokens cascade`);
  });
});
