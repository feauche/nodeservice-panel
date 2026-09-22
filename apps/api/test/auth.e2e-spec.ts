import type { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { AUTH_PROBLEM, CSRF_HEADER, csrfResponseSchema, meSchema } from '@nodeservice/shared';
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
import { SetupService } from '../src/modules/auth/setup.service.js';
import { ThrottleService } from '../src/modules/auth/throttle.service.js';

// Окружение (DATABASE_URL=nodeservice_test, VALKEY_URL db 14, LOG_LEVEL=silent) задаёт vitest.config.e2e.ts;
// БД создаёт test/global-setup.ts. Здесь только страховка от запуска против dev-БД.
if (!process.env.DATABASE_URL?.endsWith('/nodeservice_test'))
  throw new Error('e2e: DATABASE_URL должен указывать на nodeservice_test');

const LOGIN = 'Admin';
const PASSWORD = 'correct horse battery staple';

describe('auth e2e', () => {
  let app: INestApplication;
  let agent: InstanceType<typeof TestAgent>;
  let csrf: string;
  let setupToken: string;
  let totpSecret: string;
  let recoveryCodes: string[];

  const post = (path: string, body?: unknown) =>
    agent
      .post(path)
      .set(CSRF_HEADER, csrf)
      .send(body ?? {});

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication<NestExpressApplication>({ bufferLogs: false, logger: false });
    setupHttp(app as NestExpressApplication);

    const db = app.get<Db>(DB);
    await runMigrations(db);
    await db.execute(sql`truncate users, recovery_codes, trusted_devices, setup_tokens cascade`);
    await app.get<Redis>(VALKEY).flushdb();

    await app.init();
    agent = request.agent(app.getHttpServer());
    setupToken = await app.get(SetupService).issueToken();
  });

  afterAll(async () => {
    await app?.close();
  });

  it('GET /api/auth/csrf выдаёт токен и cookie', async () => {
    const res = await agent.get('/api/auth/csrf').expect(200);
    expect(csrfResponseSchema.safeParse(res.body).success).toBe(true);
    expect(res.headers['set-cookie']?.join(';')).toContain('ns.csrf=');
    csrf = res.body.token as string;
  });

  it('POST без CSRF → 403 problem+json', async () => {
    const res = await agent.post('/api/auth/login').send({ login: 'a', password: 'b' }).expect(403);
    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(res.body.type).toBe(AUTH_PROBLEM.csrf);
  });

  it('валидация → 400 с type validation', async () => {
    const res = await post('/api/auth/login', { login: '', password: '' });
    expect(res.status).toBe(400);
    expect(res.body.type).toBe(AUTH_PROBLEM.validation);
  });

  it('POST /logout без сессии → 204 (идемпотентно, cookie чистятся)', async () => {
    const res = await post('/api/auth/logout').expect(204);
    expect(res.headers['set-cookie']?.join(';')).toMatch(/(^|;|\s)sid=/);
  });

  it('GET /api/auth/status: setupRequired=true, не аутентифицирован', async () => {
    const res = await agent.get('/api/auth/status').expect(200);
    expect(res.body).toEqual({ setupRequired: true, authenticated: false, locked: false });
  });

  it('GET /api/auth/me без сессии → 401 unauthenticated', async () => {
    const res = await agent.get('/api/auth/me').expect(401);
    expect(res.body.type).toBe(AUTH_PROBLEM.unauthenticated);
  });

  it('setup/start: плохой токен → 401, валидация → 400', async () => {
    const bad = await post('/api/auth/setup/start', {
      setupToken: 'nope-nope-nope',
      login: LOGIN,
      password: PASSWORD,
    });
    expect(bad.status).toBe(401);
    expect(bad.body.type).toBe(AUTH_PROBLEM.setupToken);
    const short = await post('/api/auth/setup/start', { setupToken, login: LOGIN, password: 'short' });
    expect(short.status).toBe(400);
  });

  it('setup/start → секрет TOTP, otpauth, QR, pending-cookie', async () => {
    const res = await post('/api/auth/setup/start', { setupToken, login: LOGIN, password: PASSWORD }).expect(
      200,
    );
    expect(res.body.totpSecret).toMatch(/^[A-Z2-7]+$/);
    expect(res.body.otpauthUrl).toMatch(/^otpauth:\/\/totp\//);
    expect(res.body.qrDataUrl).toMatch(/^data:image\/svg\+xml;base64,/);
    expect(res.headers['set-cookie']?.join(';')).toContain('pending=');
    totpSecret = res.body.totpSecret as string;
  });

  it('брошенный мастер: пользователя в БД нет, setup всё ещё нужен, тот же токен запускает мастер заново', async () => {
    const db = app.get<Db>(DB);
    const [row] = (await db.execute(sql`select count(*)::int as n from users`)).rows as Array<{ n: number }>;
    expect(row?.n).toBe(0);
    expect(await app.get(SetupService).isSetupRequired()).toBe(true);
    const status = await agent.get('/api/auth/status').expect(200);
    expect(status.body.setupRequired).toBe(true);

    const res = await post('/api/auth/setup/start', { setupToken, login: LOGIN, password: PASSWORD }).expect(
      200,
    );
    expect(res.body.totpSecret).not.toBe(totpSecret);
    totpSecret = res.body.totpSecret as string;
  });

  it('setup/confirm: 5 неверных кодов → pending сгорает (401 totpRequired), мастер можно начать заново', async () => {
    for (let i = 0; i < 4; i++) {
      const bad = await post('/api/auth/setup/confirm', { code: '000000' });
      expect(bad.status).toBe(401);
      expect(bad.body.type).toBe(AUTH_PROBLEM.invalidTotp);
    }
    const fifth = await post('/api/auth/setup/confirm', { code: '000000' });
    expect(fifth.status).toBe(401);
    expect(fifth.body.type).toBe(AUTH_PROBLEM.totpRequired);
    expect(fifth.headers['set-cookie']?.join(';')).toMatch(/pending=;/);
    // без pending — даже верный код не принимается
    const noPending = await post('/api/auth/setup/confirm', { code: await generate({ secret: totpSecret }) });
    expect(noPending.status).toBe(401);
    expect(noPending.body.type).toBe(AUTH_PROBLEM.totpRequired);

    const res = await post('/api/auth/setup/start', { setupToken, login: LOGIN, password: PASSWORD }).expect(
      200,
    );
    totpSecret = res.body.totpSecret as string;
  });

  it('setup/confirm: неверный код → 401, верный → 10 кодов и сессия', async () => {
    const bad = await post('/api/auth/setup/confirm', { code: '000000' });
    expect(bad.status).toBe(401);
    expect(bad.body.type).toBe(AUTH_PROBLEM.invalidTotp);

    const code = await generate({ secret: totpSecret });
    const res = await post('/api/auth/setup/confirm', { code }).expect(200);
    expect(res.body.recoveryCodes).toHaveLength(10);
    for (const c of res.body.recoveryCodes as string[]) expect(c).toMatch(/^[A-Z2-9]{5}-[A-Z2-9]{5}$/);
    expect(res.headers['set-cookie']?.join(';')).toMatch(/(^|;|\s)sid=/);
    recoveryCodes = res.body.recoveryCodes as string[];

    // всё записано одной транзакцией: пользователь подтверждён, 10 кодов, setup-токен использован
    const db = app.get<Db>(DB);
    const [u] = (
      await db.execute(sql`select count(*)::int as n from users where totp_confirmed_at is not null`)
    ).rows as Array<{ n: number }>;
    expect(u?.n).toBe(1);
    const [t] = (await db.execute(sql`select count(*)::int as n from setup_tokens where used_at is null`))
      .rows as Array<{ n: number }>;
    expect(t?.n).toBe(0);
    expect(await app.get(SetupService).isSetupRequired()).toBe(false);
  });

  it('повторный setup/start → 409 setupDone', async () => {
    const res = await post('/api/auth/setup/start', { setupToken, login: 'other', password: PASSWORD });
    expect(res.status).toBe(409);
    expect(res.body.type).toBe(AUTH_PROBLEM.setupDone);
  });

  it('GET /me после setup → Me с amr pwd+totp; status authenticated', async () => {
    const me = await agent.get('/api/auth/me').expect(200);
    expect(me.body).toMatchObject({ login: 'admin', amr: ['pwd', 'totp'], recoveryCodesLeft: 10 });
    expect(me.body.stepUpAt).toEqual(expect.any(String));
    expect(meSchema.safeParse(me.body).success).toBe(true);
    const status = await agent.get('/api/auth/status').expect(200);
    expect(status.body).toEqual({ setupRequired: false, authenticated: true, locked: false });
  });

  it('POST /logout → 204, потом /me → 401', async () => {
    await post('/api/auth/logout').expect(204);
    await agent.get('/api/auth/me').expect(401);
  });

  it('login: 5 неверных паролей → 6-я попытка 429 с Retry-After', async () => {
    for (let i = 0; i < 4; i++) {
      const res = await post('/api/auth/login', { login: LOGIN, password: 'wrong-password-1' });
      expect(res.status).toBe(401);
      expect(res.body.type).toBe(AUTH_PROBLEM.invalidCredentials);
    }
    const fifth = await post('/api/auth/login', { login: LOGIN, password: 'wrong-password-1' });
    expect(fifth.status).toBe(429);
    expect(fifth.body.type).toBe(AUTH_PROBLEM.throttled);
    expect(fifth.body.retryAfterSeconds).toBeGreaterThan(0);
    expect(fifth.headers['retry-after']).toBeDefined();

    const sixth = await post('/api/auth/login', { login: LOGIN, password: PASSWORD });
    expect(sixth.status).toBe(429);

    // неизвестный логин с того же IP тоже заблокирован (по IP), а текст ошибки не выдаёт существование логина
    const unknown = await post('/api/auth/login', { login: 'ghost', password: PASSWORD });
    expect(unknown.status).toBe(429);

    // снимаем паузу как «прошло время»
    await app.get(ThrottleService).reset({ ip: '::ffff:127.0.0.1', login: LOGIN });
    await app.get(ThrottleService).reset({ ip: '127.0.0.1', login: LOGIN });
  });

  it('шаг TOTP: 5 неверных кодов → pending сгорает, 401 totpRequired, назад к паролю', async () => {
    await post('/api/auth/login', { login: LOGIN, password: PASSWORD }).expect(200);
    for (let i = 0; i < 4; i++) {
      const bad = await post('/api/auth/login/totp', { code: '000000' });
      expect(bad.status).toBe(401);
      expect(bad.body.type).toBe(AUTH_PROBLEM.invalidTotp);
    }
    const fifth = await post('/api/auth/login/totp', { code: '000000' });
    expect(fifth.status).toBe(401);
    expect(fifth.body.type).toBe(AUTH_PROBLEM.totpRequired);
    expect(fifth.headers['set-cookie']?.join(';')).toMatch(/pending=;/);
    const after = await post('/api/auth/login/recovery', { code: recoveryCodes[9] as string });
    expect(after.status).toBe(401);
    expect(after.body.type).toBe(AUTH_PROBLEM.totpRequired);
    // лимит шага кода не трогает throttle по паролю
    await post('/api/auth/login', { login: LOGIN, password: PASSWORD }).expect(200);
  });

  it('login ok → next=totp; totp неверный → 401; верный → сессия + trusted cookie', async () => {
    const res = await post('/api/auth/login', { login: LOGIN, password: PASSWORD }).expect(200);
    expect(res.body).toEqual({ next: 'totp' });

    const bad = await post('/api/auth/login/totp', { code: '123456' });
    expect(bad.status).toBe(401);
    expect(bad.body.type).toBe(AUTH_PROBLEM.invalidTotp);

    // код с предыдущего шага — свежий относительно последнего принятого; текущий уже мог быть использован в setup
    const code = await generate({ secret: totpSecret, epoch: Math.floor(Date.now() / 1000) + 30 });
    const ok = await post('/api/auth/login/totp', { code, rememberDevice: true }).expect(200);
    expect(ok.body.me).toMatchObject({ login: 'admin', amr: ['pwd', 'totp'], recoveryCodesLeft: 10 });
    expect(ok.headers['set-cookie']?.join(';')).toMatch(/(^|;|\s)td=/);

    const me = await agent.get('/api/auth/me').expect(200);
    expect(me.body.amr).toEqual(['pwd', 'totp']);
  });

  it('unlock: неверный пароль → 401, верный → stepUpAt обновлён', async () => {
    const bad = await post('/api/auth/unlock', { password: 'nope-nope-nope' });
    expect(bad.status).toBe(401);
    const before = (await agent.get('/api/auth/me')).body.stepUpAt as string;
    await new Promise((r) => setTimeout(r, 5));
    const ok = await post('/api/auth/unlock', { password: PASSWORD }).expect(200);
    expect(Date.parse(ok.body.me.stepUpAt)).toBeGreaterThanOrEqual(Date.parse(before));
  });

  it('доверенное устройство: после logout вход без TOTP (amr pwd+trusted)', async () => {
    await post('/api/auth/logout').expect(204);
    const res = await post('/api/auth/login', { login: LOGIN, password: PASSWORD }).expect(200);
    expect(res.body.next).toBe('done');
    expect(res.body.me.amr).toEqual(['pwd', 'trusted']);
    await agent.get('/api/auth/me').expect(200);
  });

  it('код восстановления: вход, остальные сессии и доверенные устройства удаляются, счётчик уменьшается', async () => {
    // первый клиент остаётся в сессии — после входа по коду восстановления она должна умереть
    await agent.get('/api/auth/me').expect(200);
    // без td-cookie: отдельный агент, но с тем же csrf-cookie нужно заново
    const fresh = request.agent(app.getHttpServer());
    const token = (await fresh.get('/api/auth/csrf')).body.token as string;
    const login = await fresh
      .post('/api/auth/login')
      .set(CSRF_HEADER, token)
      .send({ login: LOGIN, password: PASSWORD });
    expect(login.body).toEqual({ next: 'totp' });

    const wrong = await fresh
      .post('/api/auth/login/recovery')
      .set(CSRF_HEADER, token)
      .send({ code: 'AAAAA-AAAAA' });
    expect(wrong.status).toBe(401);
    expect(wrong.body.type).toBe(AUTH_PROBLEM.invalidRecovery);

    const code = recoveryCodes[0] as string;
    const ok = await fresh
      .post('/api/auth/login/recovery')
      .set(CSRF_HEADER, token)
      .send({ code: code.toLowerCase().replace('-', '') })
      .expect(200);
    expect(ok.body.me.amr).toEqual(['pwd', 'recovery']);
    expect(ok.body.recoveryCodesLeft).toBe(9);
    expect(ok.body.me.recoveryCodesLeft).toBe(9);

    // сессия первого клиента завершена
    const dead = await agent.get('/api/auth/me');
    expect(dead.status).toBe(401);
    expect(dead.body.type).toBe(AUTH_PROBLEM.unauthenticated);

    // тот же код второй раз — нет
    await fresh.post('/api/auth/logout').set(CSRF_HEADER, token).expect(204);
    await fresh.post('/api/auth/login').set(CSRF_HEADER, token).send({ login: LOGIN, password: PASSWORD });
    const again = await fresh.post('/api/auth/login/recovery').set(CSRF_HEADER, token).send({ code });
    expect(again.status).toBe(401);

    // доверенное устройство первого агента больше не работает → снова просят TOTP
    const relogin = await post('/api/auth/login', { login: LOGIN, password: PASSWORD }).expect(200);
    expect(relogin.body).toEqual({ next: 'totp' });
  });
});
