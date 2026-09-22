import type { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import {
  AUTH_PROBLEM,
  auditListResponseSchema,
  CSRF_HEADER,
  recoveryCodesViewSchema,
  SECURITY_PROBLEM,
  securityOverviewSchema,
  sessionsResponseSchema,
  trustedDevicesResponseSchema,
} from '@nodeservice/shared';
import { sql } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import { generate } from 'otplib';
import request from 'supertest';
import TestAgent from 'supertest/lib/agent.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AppModule } from '../src/app.module.js';
import { setupHttp } from '../src/common/http/setup-http.js';
import { DB, type Db } from '../src/infra/db/db.module.js';
import { runMigrations } from '../src/infra/db/migrate.js';
import { VALKEY } from '../src/infra/valkey/valkey.module.js';
import { SessionStore } from '../src/modules/auth/session.store.js';
import { SetupService } from '../src/modules/auth/setup.service.js';
import { UsersRepository } from '../src/modules/auth/users.repository.js';
import { PwnedPasswordsService } from '../src/modules/security/pwned-passwords.service.js';

if (!process.env.DATABASE_URL?.endsWith('/nodeservice_test'))
  throw new Error('e2e: DATABASE_URL должен указывать на nodeservice_test');

const LOGIN = 'admin';
const PASSWORD = 'correct horse battery staple';
const NEW_PASSWORD = 'another long passphrase 42';

type Agent = InstanceType<typeof TestAgent>;

describe('security e2e', () => {
  let app: INestApplication;
  let db: Db;
  let main: Agent;
  let csrf: string;
  let totpSecret: string;
  let userId: string;
  let lastCode = '';

  /** Код TOTP из окна, которое ещё не использовалось (anti-replay на сервере). */
  const freshCode = async (secret = totpSecret): Promise<string> => {
    let code = await generate({ secret });
    while (code === lastCode) {
      await new Promise((r) => setTimeout(r, 1000));
      code = await generate({ secret });
    }
    lastCode = code;
    return code;
  };

  const newAgent = async (): Promise<{ agent: Agent; csrf: string }> => {
    const agent = request.agent(app.getHttpServer());
    const token = (await agent.get('/api/auth/csrf').expect(200)).body.token as string;
    return { agent, csrf: token };
  };

  /** Полный вход паролем + кодом (опционально «запомнить устройство»). */
  const login = async (password = PASSWORD, rememberDevice = false, secret = totpSecret) => {
    const { agent, csrf: token } = await newAgent();
    const step = await agent
      .post('/api/auth/login')
      .set(CSRF_HEADER, token)
      .send({ login: LOGIN, password })
      .expect(200);
    if (step.body.next === 'done') return { agent, csrf: token };
    await agent
      .post('/api/auth/login/totp')
      .set(CSRF_HEADER, token)
      .send({ code: await freshCode(secret), rememberDevice })
      .expect(200);
    return { agent, csrf: token };
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication<NestExpressApplication>({ bufferLogs: false, logger: false });
    setupHttp(app as NestExpressApplication);
    db = app.get<Db>(DB);
    await runMigrations(db);
    await db.execute(sql`truncate users, recovery_codes, trusted_devices, setup_tokens cascade`);
    await db.execute(sql`delete from app_meta where key = 'settings.security'`);
    await app.get<Redis>(VALKEY).flushdb();
    await app.init();

    ({ agent: main, csrf } = await newAgent());
    const setupToken = await app.get(SetupService).issueToken();
    const start = await main
      .post('/api/auth/setup/start')
      .set(CSRF_HEADER, csrf)
      .send({ setupToken, login: LOGIN, password: PASSWORD })
      .expect(200);
    totpSecret = start.body.totpSecret as string;
    await main
      .post('/api/auth/setup/confirm')
      .set(CSRF_HEADER, csrf)
      .send({ code: await freshCode() })
      .expect(200);
    const user = await app.get(UsersRepository).findByLogin(LOGIN);
    userId = user?.id ?? '';
  });

  afterAll(async () => {
    await app?.close();
  });

  it('overview: пароль, 2FA, коды, сессии, политика по умолчанию; без сессии — 401', async () => {
    const body = securityOverviewSchema.parse((await main.get('/api/security/overview').expect(200)).body);
    expect(body).toMatchObject({
      login: LOGIN,
      recoveryCodesLeft: 10,
      recoveryCodesTotal: 10,
      sessionsCount: 1,
      trustedDevicesCount: 0,
      policy: { idleMinutes: 360, lockAfterMinutes: 30, alwaysAskTotp: false },
    });
    expect(body.totpConfirmedAt).not.toBeNull();
    await request(app.getHttpServer()).get('/api/security/overview').expect(401);
  });

  it('step-up: старое подтверждение пароля → 403, после /auth/unlock — новые коды восстановления', async () => {
    const sessions = app.get(SessionStore);
    const [session] = await sessions.listForUser(userId);
    if (!session) throw new Error('нет сессии');
    await sessions.setStepUp(session.id, new Date(Date.now() - 10 * 60_000));

    const denied = await main.post('/api/security/recovery-codes').set(CSRF_HEADER, csrf).expect(403);
    expect(denied.body.type).toBe(AUTH_PROBLEM.stepUp);

    await main.post('/api/auth/unlock').set(CSRF_HEADER, csrf).send({ password: PASSWORD }).expect(200);
    const res = await main.post('/api/security/recovery-codes').set(CSRF_HEADER, csrf).expect(200);
    expect(res.body.recoveryCodes).toHaveLength(10);
    expect(await app.get(UsersRepository).countUnusedRecoveryCodes(userId)).toBe(10);
  });

  it('политика: PUT за step-up, diff в Журнале, idle влияет на TTL сессии', async () => {
    const res = await main
      .put('/api/security/policy')
      .set(CSRF_HEADER, csrf)
      .send({ idleMinutes: 15, lockAfterMinutes: 10 })
      .expect(200);
    expect(res.body).toEqual({ idleMinutes: 15, lockAfterMinutes: 10, alwaysAskTotp: false });
    await main.put('/api/security/policy').set(CSRF_HEADER, csrf).send({ idleMinutes: 1 }).expect(400);

    const audit = auditListResponseSchema.parse(
      (await main.get('/api/audit?category=security').expect(200)).body,
    );
    const entry = audit.items.find((e) => e.action === 'security.policy.updated');
    expect(entry?.changes?.idleMinutes).toEqual({ before: 360, after: 15 });

    // скользящий TTL сессии теперь ≤ 15 минут
    await main.get('/api/auth/me').expect(200);
    const [session] = await app.get(SessionStore).listForUser(userId);
    const ttl = await app.get<Redis>(VALKEY).pttl(`sess:${session?.id}`);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(15 * 60_000);
  });

  it('блокировка экрана: вручную и по бездействию; заблокированная сессия ждёт пароль', async () => {
    // вручную
    await main.post('/api/auth/lock').set(CSRF_HEADER, csrf).expect(204);
    expect((await main.get('/api/auth/me').expect(200)).body.locked).toBe(true);
    expect((await main.get('/api/auth/status').expect(200)).body.locked).toBe(true);
    const denied = await main.get('/api/security/overview').expect(403);
    expect(denied.body.type).toBe(AUTH_PROBLEM.locked);
    await main.post('/api/auth/unlock').set(CSRF_HEADER, csrf).send({ password: PASSWORD }).expect(200);
    expect((await main.get('/api/auth/me').expect(200)).body.locked).toBe(false);
    await main.get('/api/security/overview').expect(200);

    // по бездействию: пауза между запросами больше lockAfterMinutes → сервер блокирует сам
    await main.put('/api/security/policy').set(CSRF_HEADER, csrf).send({ lockAfterMinutes: 5 }).expect(200);
    const [session] = await app.get(SessionStore).listForUser(userId);
    await app
      .get<Redis>(VALKEY)
      .hset(`sess:${session?.id}`, { lastSeenAt: new Date(Date.now() - 10 * 60_000).toISOString() });
    expect((await main.get('/api/auth/me').expect(200)).body.locked).toBe(true);
    await main.get('/api/security/sessions').expect(403);
    await main.get('/api/audit').expect(403); // Журнал тоже за паролем
    await main.post('/api/auth/unlock').set(CSRF_HEADER, csrf).send({ password: PASSWORD }).expect(200);
    const audit = auditListResponseSchema.parse(
      (await main.get('/api/audit?category=auth').expect(200)).body,
    );
    expect(audit.items.some((e) => e.action === 'auth.lock' && e.source === 'auto')).toBe(true);
    expect(audit.items.some((e) => e.action === 'auth.lock' && e.source === 'manual')).toBe(true);
    await main.put('/api/security/policy').set(CSRF_HEADER, csrf).send({ lockAfterMinutes: 30 }).expect(200);
  });

  it('сессии: список с current, завершить чужую, текущую — нельзя, «все кроме текущей»', async () => {
    const other = await login();
    const list = sessionsResponseSchema.parse((await main.get('/api/security/sessions').expect(200)).body);
    expect(list.items).toHaveLength(2);
    const current = list.items.find((s) => s.current);
    const foreign = list.items.find((s) => !s.current);
    expect(current?.amr).toEqual(['pwd', 'totp']);
    expect(foreign?.ip).toBeTruthy();

    const self = await main
      .delete(`/api/security/sessions/${current?.id}`)
      .set(CSRF_HEADER, csrf)
      .expect(400);
    expect(self.body.type).toBe(SECURITY_PROBLEM.currentSession);
    await main.delete('/api/security/sessions/not-an-id').set(CSRF_HEADER, csrf).expect(400);

    expect(
      (await main.delete(`/api/security/sessions/${foreign?.id}`).set(CSRF_HEADER, csrf).expect(200)).body,
    ).toEqual({ revoked: 1 });
    await other.agent.get('/api/auth/me').expect(401);
    // повтор — идемпотентно
    expect(
      (await main.delete(`/api/security/sessions/${foreign?.id}`).set(CSRF_HEADER, csrf).expect(200)).body,
    ).toEqual({ revoked: 0 });

    await login();
    await login();
    expect(
      (await main.post('/api/security/sessions/revoke-others').set(CSRF_HEADER, csrf).expect(200)).body,
    ).toEqual({ revoked: 2 });
    expect(
      sessionsResponseSchema.parse((await main.get('/api/security/sessions').expect(200)).body).items,
    ).toHaveLength(1);
  }, 120_000);

  it('устройства: запомненное устройство в списке; alwaysAskTotp заставляет спрашивать код; удаление и очистка', async () => {
    const remembered = await login(PASSWORD, true);
    const devices = trustedDevicesResponseSchema.parse(
      (await main.get('/api/security/trusted-devices').expect(200)).body,
    );
    expect(devices.items).toHaveLength(1);
    expect(devices.items[0]?.current).toBe(false); // cookie устройства — у другого агента
    const mine = trustedDevicesResponseSchema.parse(
      (await remembered.agent.get('/api/security/trusted-devices').expect(200)).body,
    );
    expect(mine.items[0]?.current).toBe(true);

    // с cookie устройства вход без кода
    await remembered.agent.post('/api/auth/logout').set(CSRF_HEADER, remembered.csrf).expect(204);
    const quick = await remembered.agent
      .post('/api/auth/login')
      .set(CSRF_HEADER, remembered.csrf)
      .send({ login: LOGIN, password: PASSWORD })
      .expect(200);
    expect(quick.body.next).toBe('done');

    // политика «всегда спрашивать код» — устройство больше не пропускает
    await main.put('/api/security/policy').set(CSRF_HEADER, csrf).send({ alwaysAskTotp: true }).expect(200);
    await remembered.agent.post('/api/auth/logout').set(CSRF_HEADER, remembered.csrf).expect(204);
    const strict = await remembered.agent
      .post('/api/auth/login')
      .set(CSRF_HEADER, remembered.csrf)
      .send({ login: LOGIN, password: PASSWORD })
      .expect(200);
    expect(strict.body.next).toBe('totp');
    await main.put('/api/security/policy').set(CSRF_HEADER, csrf).send({ alwaysAskTotp: false }).expect(200);

    const id = devices.items[0]?.id ?? '';
    expect(
      (await main.delete(`/api/security/trusted-devices/${id}`).set(CSRF_HEADER, csrf).expect(200)).body,
    ).toEqual({ revoked: 1 });
    await main.delete('/api/security/trusted-devices/not-uuid').set(CSRF_HEADER, csrf).expect(400);
    await login(PASSWORD, true);
    expect(
      (await main.post('/api/security/trusted-devices/clear').set(CSRF_HEADER, csrf).expect(200)).body,
    ).toEqual({ revoked: 1 });
    expect(
      trustedDevicesResponseSchema.parse((await main.get('/api/security/trusted-devices').expect(200)).body)
        .items,
    ).toHaveLength(0);
  }, 120_000);

  it('перевыпуск 2FA: неверный код → 401, верный → старый секрет не работает, устройства и сессии сброшены', async () => {
    await main.post('/api/security/sessions/revoke-others').set(CSRF_HEADER, csrf).expect(200); // чистый счёт
    await login(PASSWORD, true); // устройство + вторая сессия — должны исчезнуть
    await main.post('/api/auth/unlock').set(CSRF_HEADER, csrf).send({ password: PASSWORD }).expect(200);

    const expired = await main
      .post('/api/security/totp/confirm')
      .set(CSRF_HEADER, csrf)
      .send({ code: '123456' })
      .expect(400);
    expect(expired.body.type).toBe(SECURITY_PROBLEM.totpReissueExpired);

    const start = await main.post('/api/security/totp/reissue').set(CSRF_HEADER, csrf).expect(200);
    const newSecret = start.body.totpSecret as string;
    expect(newSecret).toMatch(/^[A-Z2-7]+$/);
    expect(newSecret).not.toBe(totpSecret);
    expect(start.body.qrDataUrl).toMatch(/^data:image/);

    const bad = await main
      .post('/api/security/totp/confirm')
      .set(CSRF_HEADER, csrf)
      .send({ code: '000000' })
      .expect(401);
    expect(bad.body.type).toBe(AUTH_PROBLEM.invalidTotp);

    const ok = await main
      .post('/api/security/totp/confirm')
      .set(CSRF_HEADER, csrf)
      .send({ code: await generate({ secret: newSecret }) })
      .expect(200);
    expect(ok.body).toMatchObject({ sessionsRevoked: 1, trustedDevicesRemoved: 1 });
    expect(ok.body.me.login).toBe(LOGIN);

    // старый секрет больше не подходит, новый — работает (в новом окне: anti-replay)
    const { agent, csrf: token } = await newAgent();
    await agent
      .post('/api/auth/login')
      .set(CSRF_HEADER, token)
      .send({ login: LOGIN, password: PASSWORD })
      .expect(200);
    const oldCode = await freshCode(totpSecret);
    const rejected = await agent
      .post('/api/auth/login/totp')
      .set(CSRF_HEADER, token)
      .send({ code: oldCode })
      .expect(401);
    expect(rejected.body.type).toBe(AUTH_PROBLEM.invalidTotp);
    totpSecret = newSecret;
    lastCode = await generate({ secret: newSecret }); // уже использован при подтверждении
    await agent
      .post('/api/auth/login/totp')
      .set(CSRF_HEADER, token)
      .send({ code: await freshCode() })
      .expect(200);
  }, 120_000);

  it('смена пароля: неверный текущий → 401 (+ failed в Журнале), верный → другие сессии завершены, новый пароль работает', async () => {
    await main.post('/api/security/sessions/revoke-others').set(CSRF_HEADER, csrf).expect(200); // чистый счёт
    const other = await login();
    const wrong = await main
      .post('/api/security/password')
      .set(CSRF_HEADER, csrf)
      .send({ currentPassword: 'wrong wrong wrong', newPassword: NEW_PASSWORD })
      .expect(401);
    expect(wrong.body.type).toBe(AUTH_PROBLEM.invalidCredentials);
    await main
      .post('/api/security/password')
      .set(CSRF_HEADER, csrf)
      .send({ currentPassword: PASSWORD, newPassword: PASSWORD })
      .expect(400);

    const res = await main
      .post('/api/security/password')
      .set(CSRF_HEADER, csrf)
      .send({ currentPassword: PASSWORD, newPassword: NEW_PASSWORD })
      .expect(200);
    expect(res.body.sessionsRevoked).toBe(1);
    await other.agent.get('/api/auth/me').expect(401);
    await main.get('/api/auth/me').expect(200);

    const audit = auditListResponseSchema.parse(
      (await main.get('/api/audit?category=security').expect(200)).body,
    );
    const changes = audit.items.filter((e) => e.action === 'security.password.changed');
    expect(changes.some((e) => e.result === 'failed')).toBe(true);
    expect(changes.some((e) => e.result === 'ok' && e.metadata.sessionsRevoked === 1)).toBe(true);
    // ни одна запись не содержит паролей
    expect(JSON.stringify(audit)).not.toContain(NEW_PASSWORD);

    const { agent, csrf: token } = await newAgent();
    await agent
      .post('/api/auth/login')
      .set(CSRF_HEADER, token)
      .send({ login: LOGIN, password: PASSWORD })
      .expect(401);
    await agent
      .post('/api/auth/login')
      .set(CSRF_HEADER, token)
      .send({ login: LOGIN, password: NEW_PASSWORD })
      .expect(200);
  }, 120_000);

  it('проверка по утечкам: найден / не найден / сеть недоступна (fail-open)', async () => {
    const config = { get: () => true } as unknown as ConstructorParameters<typeof PwnedPasswordsService>[0];
    // sha1('password') = 5BAA61E4C9B93F3F0682250B6CF8331B7EE68FD8 → префикс 5BAA6, суффикс 1E4C9…
    const hit = new PwnedPasswordsService(
      config,
      async () => new Response('1E4C9B93F3F0682250B6CF8331B7EE68FD8:3861493\r\nAAAA:1'),
    );
    expect(await hit.isPwned('password')).toBe(true);
    const miss = new PwnedPasswordsService(config, async () => new Response('AAAA:1\r\nBBBB:0'));
    expect(await miss.isPwned('password')).toBe(false);
    const down = new PwnedPasswordsService(config, async () => {
      throw new Error('ENETUNREACH');
    });
    expect(await down.isPwned('password')).toBe(false);
    const disabled = new PwnedPasswordsService(
      { get: () => false } as unknown as typeof config,
      async () => new Response('1E4C9B93F3F0682250B6CF8331B7EE68FD8:1'),
    );
    expect(await disabled.isPwned('password')).toBe(false);
  });

  it('просмотр кодов: за step-up, совпадают с выпущенными, использованный помечается, просмотр — в Журнале', async () => {
    await main.post('/api/auth/unlock').set(CSRF_HEADER, csrf).send({ password: NEW_PASSWORD }).expect(200);
    const issued = (await main.post('/api/security/recovery-codes').set(CSRF_HEADER, csrf).expect(200)).body
      .recoveryCodes as string[];
    const view = recoveryCodesViewSchema.parse(
      (await main.get('/api/security/recovery-codes').expect(200)).body,
    );
    expect(view.codes.map((c) => c.code)).toEqual(issued);
    expect(view.codes.every((c) => c.usedAt === null)).toBe(true);

    // вход по коду (новый агент; остальные сессии при этом сбрасываются — поэтому тест последний)
    const { agent, csrf: token } = await newAgent();
    await agent
      .post('/api/auth/login')
      .set(CSRF_HEADER, token)
      .send({ login: LOGIN, password: NEW_PASSWORD })
      .expect(200);
    await agent
      .post('/api/auth/login/recovery')
      .set(CSRF_HEADER, token)
      .send({ code: issued[0] })
      .expect(200);
    const after = recoveryCodesViewSchema.parse(
      (await agent.get('/api/security/recovery-codes').expect(200)).body,
    );
    expect(after.codes[0]?.usedAt).not.toBeNull();
    expect(after.codes.filter((c) => c.usedAt === null)).toHaveLength(9);

    const audit = auditListResponseSchema.parse(
      (await agent.get('/api/audit?category=security').expect(200)).body,
    );
    expect(audit.items.some((e) => e.action === 'security.recovery_codes.viewed')).toBe(true);
    expect(JSON.stringify(audit)).not.toContain(issued[1]);
  }, 120_000);
});
