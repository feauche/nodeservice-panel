import type { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { AUTH_PROBLEM, CSRF_HEADER } from '@nodeservice/shared';
import { sql } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import { generate } from 'otplib';
import request from 'supertest';
import TestAgent from 'supertest/lib/agent.js';
import { afterAll, beforeAll, beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest';

import { AppModule } from '../src/app.module.js';
import { CryptoService } from '../src/common/crypto/crypto.service.js';
import { setupHttp } from '../src/common/http/setup-http.js';
import { DB, type Db } from '../src/infra/db/db.module.js';
import { runMigrations } from '../src/infra/db/migrate.js';
import { VALKEY } from '../src/infra/valkey/valkey.module.js';
import { AnonAuditLimiter } from '../src/modules/auth/anon-audit.limiter.js';
import { AuthEventsService } from '../src/modules/auth/auth-events.service.js';
import { SecurityPolicyStore } from '../src/modules/auth/security-policy.store.js';
import { SetupService } from '../src/modules/auth/setup.service.js';
import { deleteByPattern } from '../src/modules/auth/test-valkey.js';
import { TotpService } from '../src/modules/auth/totp.service.js';
import { UsersRepository } from '../src/modules/auth/users.repository.js';
import { NotificationsService, type PushInput } from '../src/modules/notifications/notifications.service.js';

// Страховка от запуска против dev-БД.
if (!process.env.DATABASE_URL?.endsWith('/nodeservice_test'))
  throw new Error('e2e: DATABASE_URL должен указывать на nodeservice_test');

const LOGIN = 'admin';
const PASSWORD = 'correct horse battery staple';
const WRONG = 'wrong-password-1';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const NEW_DEVICE = 'Вход в панель с нового устройства';

type Agent = InstanceType<typeof TestAgent>;
interface Client {
  agent: Agent;
  ip: string;
  post: (path: string, body?: unknown) => request.Test;
}
interface JournalRow extends Record<string, unknown> {
  action: string;
  ip: string | null;
  actor_display: string;
  request_id: string | null;
  metadata: Record<string, unknown>;
}

/** Вход в панель и защита от перебора: паузы, уведомления, Журнал (пакет находок b4). */
describe('login guard e2e', () => {
  let app: INestApplication;
  /**
   * Адрес настоящего слушающего сервера. Тесты шлют залпы параллельных запросов, а supertest, получив
   * неслушающий сервер, поднимает и закрывает его на каждый запрос — параллельные при этом рвутся.
   */
  let base: string;
  let db: Db;
  let valkey: Redis;
  let push: MockInstance<(input: PushInput) => Promise<void>>;
  let totpSecret: string;
  let recoveryCodes: string[];
  let userId: string;
  /** Номер последней записи Журнала до теста: Журнал не очищается, смотрим только своё. */
  let seq0 = 0;

  /** Клиент со своим адресом (панель стоит за прокси — адрес берётся из X-Forwarded-For). */
  const newClient = async (ip: string): Promise<Client> => {
    const agent = request.agent(base);
    const csrf = (await agent.get('/api/auth/csrf').set('X-Forwarded-For', ip).expect(200)).body
      .token as string;
    return {
      agent,
      ip,
      post: (path, body) =>
        agent
          .post(path)
          .set('X-Forwarded-For', ip)
          .set(CSRF_HEADER, csrf)
          .send(body ?? {}),
    };
  };
  const login = (c: Client, password = PASSWORD, name = LOGIN) =>
    c.post('/api/auth/login', { login: name, password });
  /** Свежий код: память о последнем принятом шаге стираем, чтобы не ждать следующие 30 секунд. */
  const code = async (): Promise<string> => {
    await app.get(TotpService).forget(userId);
    return generate({ secret: totpSecret });
  };
  const fullLogin = async (c: Client, rememberDevice = false): Promise<void> => {
    const step = await login(c).expect(200);
    if (step.body.next === 'done') return;
    await c.post('/api/auth/login/totp', { code: await code(), rememberDevice }).expect(200);
  };
  /** Пять неверных паролей: четыре раза 401, на пятом включается пауза. */
  const wrongSeries = async (c: Client, name = LOGIN): Promise<void> => {
    for (let i = 0; i < 4; i++) await login(c, WRONG, name).expect(401);
    const fifth = await login(c, WRONG, name).expect(429);
    expect(fifth.body.type).toBe(AUTH_PROBLEM.throttled);
  };
  /** «Прошло время»: паузы кончились, счёт серий остался. */
  const endPauses = () => deleteByPattern(valkey, 'throttle:block:*');
  const journal = async (action: string): Promise<JournalRow[]> =>
    (
      await db.execute<JournalRow>(
        sql`select action, host(ip) as ip, actor_display, request_id, metadata
            from audit_log where seq > ${seq0} and action = ${action} order by seq`,
      )
    ).rows;
  const pushed = (): PushInput[] => push.mock.calls.map(([input]) => input);
  /** Уведомления о сериях и лимитах — всё, кроме обычного «вход с нового устройства». */
  const alerts = (): PushInput[] => pushed().filter((p) => p.title !== NEW_DEVICE);
  /** Записи, которые пишутся без ожидания (отказ по CSRF), должны успеть дойти до базы. */
  const settle = async (action: string): Promise<JournalRow[]> => {
    let rows = await journal(action);
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 100));
      const next = await journal(action);
      if (next.length === rows.length) return next;
      rows = next;
    }
    return rows;
  };
  /** Лимит записей считается по минутам: у самой границы минуты ждём следующую, чтобы счёт был точным. */
  const awayFromMinuteEdge = async (): Promise<void> => {
    const s = new Date().getSeconds();
    if (s >= 52) await new Promise((r) => setTimeout(r, (61 - s) * 1000));
  };
  const skippedIn = (rows: JournalRow[]): number =>
    rows.reduce((sum, r) => sum + Number(/\d+/.exec(String(r.metadata.note))?.[0] ?? 0), 0);

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication<NestExpressApplication>({ bufferLogs: false, logger: false });
    setupHttp(app as NestExpressApplication);
    db = app.get<Db>(DB);
    await runMigrations(db);
    await db.execute(sql`truncate users, recovery_codes, trusted_devices, setup_tokens cascade`);
    await db.execute(sql`delete from app_meta where key = 'settings.security'`);
    valkey = app.get<Redis>(VALKEY);
    await valkey.flushdb();
    await app.listen(0, '127.0.0.1');
    base = await app.getUrl();
    push = vi.spyOn(app.get(NotificationsService), 'push');

    const owner = await newClient('192.0.2.1');
    const setupToken = await app.get(SetupService).issueToken();
    const start = await owner
      .post('/api/auth/setup/start', { setupToken, login: LOGIN, password: PASSWORD })
      .expect(200);
    totpSecret = start.body.totpSecret as string;
    const done = await owner
      .post('/api/auth/setup/confirm', { code: await generate({ secret: totpSecret }) })
      .expect(200);
    recoveryCodes = done.body.recoveryCodes as string[];
    userId = (await app.get(UsersRepository).findByLogin(LOGIN))?.id ?? '';
    await owner.post('/api/auth/logout').expect(204);
  }, 60_000);

  afterAll(async () => {
    await app?.close();
  });

  beforeEach(async () => {
    await deleteByPattern(valkey, 'throttle:*');
    await deleteByPattern(valkey, 'audit:anon:*');
    push.mockClear();
    const [row] = (await db.execute(sql`select coalesce(max(seq), 0)::int as seq from audit_log`))
      .rows as Array<{ seq: number }>;
    seq0 = row?.seq ?? 0;
  });

  /* ---------- api-platform#2, x-db#3: уведомление один раз на серию ---------- */

  it('серия неудач: одно уведомление в момент включения паузы; отказы на паузе — без уведомлений и без записи на каждый', async () => {
    const c = await newClient('198.51.100.10');
    await wrongSeries(c);
    // Пауза идёт: даже верный пароль получает отказ. Двенадцать таких запросов — ни одного сообщения.
    for (let i = 0; i < 12; i++) await login(c).expect(429);

    const sent = alerts();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      title: 'Серия неудачных попыток входа',
      severity: 'info',
      telegram: { event: 'login' },
    });
    expect(sent[0]?.body).toContain('Логин «admin»');
    expect(sent[0]?.body).toContain('Адрес 198.51.100.10');
    expect(sent[0]?.body).toContain('приостановлен на 30 с');
    expect(sent[0]?.body).not.toContain('заблокирован');

    expect(await journal('auth.login.failed')).toHaveLength(5);
    const paused = await journal('auth.login.throttled');
    expect(paused).toHaveLength(1);
    expect(String(paused[0]?.metadata.note)).toContain('приостановлен на 30 с');

    // Отказы попадают в Журнал одной сводной записью — когда пауза кончилась (здесь — по требованию).
    expect(await journal('auth.login.rejected')).toHaveLength(0);
    await app.get(AuthEventsService, { strict: false }).flushRejected();
    const summary = await journal('auth.login.rejected');
    expect(summary).toHaveLength(1);
    expect(summary[0]?.metadata).toMatchObject({ login: LOGIN, note: 'Отклонено попыток: 12' });
    expect(summary[0]?.actor_display).toBe(LOGIN);
  });

  it('кулдаун: следующая серия той же пары адрес/логин молчит; сообщение после него называет число отклонённых попыток', async () => {
    const c = await newClient('198.51.100.11');
    await wrongSeries(c);
    expect(alerts()).toHaveLength(1);
    for (let i = 0; i < 3; i++) await login(c, WRONG).expect(429);

    await endPauses();
    await wrongSeries(c); // вторая серия: пауза уже минута
    for (let i = 0; i < 2; i++) await login(c, WRONG).expect(429);
    expect(alerts()).toHaveLength(1);
    // в Журнале при этом каждая пауза на месте
    expect(await journal('auth.login.throttled')).toHaveLength(2);

    await endPauses();
    await deleteByPattern(valkey, 'throttle:notified:*'); // «прошёл час»
    await wrongSeries(c);
    const sent = alerts();
    expect(sent).toHaveLength(2);
    expect(sent[1]?.body).toContain('приостановлен на 5 мин');
    expect(sent[1]?.body).toContain('С прошлого сообщения отклонено попыток: 5.');
  });

  /* ---------- api-platform#1: второй шаг в общих паузах ---------- */

  it('неверные коды считаются в общих паузах, верный пароль счёт не обнуляет; уведомление говорит правду', async () => {
    const c = await newClient('198.51.100.20');
    for (let i = 0; i < 3; i++) await login(c, WRONG).expect(401);
    expect((await login(c).expect(200)).body).toEqual({ next: 'totp' });
    const fourth = await c.post('/api/auth/login/totp', { code: '000000' });
    expect(fourth.status).toBe(401);
    expect(fourth.body.type).toBe(AUTH_PROBLEM.invalidTotp);
    // пятая неудача подряд (три пароля + два кода) — пауза, хотя пароль между ними был верным
    const fifth = await c.post('/api/auth/login/totp', { code: '000000' });
    expect(fifth.status).toBe(429);
    expect(fifth.body.type).toBe(AUTH_PROBLEM.throttled);
    expect(fifth.body.retryAfterSeconds).toBeGreaterThan(0);
    // пауза общая: закрыты и шаг пароля, и начатый шаг кода (даже с верным кодом)
    await login(c).expect(429);
    expect((await c.post('/api/auth/login/totp', { code: await code() })).status).toBe(429);

    const sent = alerts();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      title: 'Пароль введён верно, но код не подошёл',
      severity: 'warn',
      telegram: { event: 'login' },
    });
    expect(sent[0]?.body).toContain('пароль введён верно, но код из приложения не подошёл');
    expect(sent[0]?.body).toContain('приостановлен на 30 с');
    expect(sent[0]?.body).toContain('Если это не вы — смените пароль');
    expect(sent[0]?.body).not.toContain('заблокирован');

    // Владелец не заперт: пауза прошла — тот же шаг кода доводится до конца.
    await endPauses();
    await c.post('/api/auth/login/totp', { code: await code() }).expect(200);
  });

  it('пять неверных кодов подряд: шаг сгорает и включается настоящая пауза', async () => {
    const c = await newClient('198.51.100.21');
    await login(c).expect(200);
    for (let i = 0; i < 4; i++) {
      const bad = await c.post('/api/auth/login/totp', { code: '000000' });
      expect(bad.status).toBe(401);
      expect(bad.body.type).toBe(AUTH_PROBLEM.invalidTotp);
    }
    const fifth = await c.post('/api/auth/login/totp', { code: '000000' });
    expect(fifth.status).toBe(401);
    expect(fifth.body.type).toBe(AUTH_PROBLEM.totpRequired);
    expect(fifth.headers['set-cookie']?.join(';')).toMatch(/pending=;/);
    // назад к паролю — а там пауза: новый шаг с пятью свежими попытками сразу не получить
    const again = await login(c);
    expect(again.status).toBe(429);
    expect(again.body.retryAfterSeconds).toBeGreaterThan(25);

    expect(alerts().map((p) => p.title)).toEqual(['Пароль введён верно, но код не подошёл']);
    expect(await journal('auth.totp.failed')).toHaveLength(5);
    expect(await journal('auth.login.throttled')).toHaveLength(1);
  });

  it('заготовленные заранее шаги кода не дают лишних попыток: залп по десяти шагам — всего пять проверок кода', async () => {
    // Знающий пароль заранее открывает десять шагов кода (верный пароль — не неудача, паузы нет)…
    const clients: Client[] = [];
    for (let i = 0; i < 10; i++) {
      const c = await newClient('198.51.100.26');
      await login(c).expect(200);
      clients.push(c);
    }
    // …и разом шлёт по пять кодов на каждый: раньше это было пятьдесят проверок.
    const verify = vi.spyOn(app.get(TotpService), 'verify');
    try {
      const all = await Promise.all(
        clients.flatMap((c) =>
          Array.from({ length: 5 }, () => c.post('/api/auth/login/totp', { code: '000000' })),
        ),
      );
      expect(verify).toHaveBeenCalledTimes(5);
      expect(all.filter((r) => r.status === 429).length).toBeGreaterThanOrEqual(45);
      expect(all.every((r) => r.status === 401 || r.status === 429)).toBe(true);
    } finally {
      verify.mockRestore();
    }
    // пауза общая: ни один из оставшихся шагов и ни один новый не работают, пока она идёт
    expect((await clients[0]?.post('/api/auth/login/totp', { code: await code() }))?.status).not.toBe(200);
    await login(clients[1] as Client).expect(429);
    expect(alerts().map((p) => p.title)).toEqual(['Пароль введён верно, но код не подошёл']);
  });

  it('неверные коды восстановления считаются так же: пять подряд — шаг сгорает, пауза, честное сообщение', async () => {
    const c = await newClient('198.51.100.25');
    await login(c).expect(200);
    for (let i = 0; i < 4; i++) {
      const bad = await c.post('/api/auth/login/recovery', { code: 'AAAAA-AAAAA' });
      expect(bad.status).toBe(401);
      expect(bad.body.type).toBe(AUTH_PROBLEM.invalidRecovery);
    }
    const fifth = await c.post('/api/auth/login/recovery', { code: 'AAAAA-AAAAA' });
    expect(fifth.status).toBe(401);
    expect(fifth.body.type).toBe(AUTH_PROBLEM.totpRequired);
    expect((await login(c)).status).toBe(429);

    const sent = alerts();
    expect(sent).toHaveLength(1);
    expect(sent[0]?.title).toBe('Пароль введён верно, но код не подошёл');
    expect(sent[0]?.body).toContain('пароль введён верно, но код восстановления не подошёл');
  });

  it('счётчики неудач сбрасываются только после полного входа', async () => {
    const c = await newClient('198.51.100.22');
    for (let i = 0; i < 2; i++) await login(c, WRONG).expect(401);
    await login(c).expect(200);
    expect((await c.post('/api/auth/login/totp', { code: '000000' })).status).toBe(401);
    // три неудачи накоплено; верный код — полный вход, счёт с нуля
    await c.post('/api/auth/login/totp', { code: await code() }).expect(200);
    await c.post('/api/auth/logout').expect(204);
    for (let i = 0; i < 4; i++) await login(c, WRONG).expect(401);
    expect(alerts()).toHaveLength(0);
  });

  it('пятый неверный код за сутки без паузы тоже даёт сообщение: медленный перебор не остаётся незамеченным', async () => {
    const c = await newClient('198.51.100.24');
    await valkey.set('throttle:2fa:admin', '4', 'EX', 3600);
    await login(c).expect(200);
    expect((await c.post('/api/auth/login/totp', { code: '000000' })).status).toBe(401);
    const sent = alerts();
    expect(sent.map((p) => p.title)).toEqual(['Пароль введён верно, но код не подошёл']);
    expect(sent[0]?.body).toContain('За сутки так было уже 5 раз');
    expect(sent[0]?.body).not.toContain('приостановлен');
    // шестой — молча
    expect((await c.post('/api/auth/login/totp', { code: '000000' })).status).toBe(401);
    expect(alerts()).toHaveLength(1);
  });

  it('суточный лимит неверных кодов: вход по коду из приложения закрывается, запомненное устройство и код восстановления работают', async () => {
    const owner = await newClient('192.0.2.10');
    await fullLogin(owner, true);
    await owner.post('/api/auth/logout').expect(204);
    push.mockClear();

    await valkey.set('throttle:2fa:admin', '19', 'EX', 3600);
    const c = await newClient('198.51.100.23');
    await login(c).expect(200);
    const twentieth = await c.post('/api/auth/login/totp', { code: '000000' });
    expect(twentieth.status).toBe(401);
    expect(twentieth.body.type).toBe(AUTH_PROBLEM.invalidTotp);

    // даже верный код больше не принимается — до конца окна
    const closed = await c.post('/api/auth/login/totp', { code: await code() });
    expect(closed.status).toBe(429);
    expect(closed.body.type).toBe(AUTH_PROBLEM.codeEntryClosed);
    expect(closed.body.retryAfterSeconds).toBeGreaterThan(3500);
    expect(closed.body.retryAfterSeconds).toBeLessThanOrEqual(3600);
    expect(closed.body.detail).toContain('по коду восстановления');
    for (let i = 0; i < 3; i++)
      expect((await c.post('/api/auth/login/totp', { code: '000000' })).status).toBe(429);

    // одно сообщение и одна запись — в момент закрытия, а не на каждый отказ
    const sent = alerts();
    expect(sent.map((p) => p.title)).toEqual(['Вход по коду из приложения закрыт']);
    expect(sent[0]).toMatchObject({ severity: 'warn', telegram: { event: 'login' } });
    expect(sent[0]?.body).toContain('20 раз');
    expect(sent[0]?.body).toContain('Если это не вы — смените пароль');
    expect(await journal('auth.totp.limit')).toHaveLength(1);

    // Владелец не заперт: запомненное устройство входит без кода…
    const back = await login(owner).expect(200);
    expect(back.body.next).toBe('done');
    // …а на новом устройстве работает код восстановления (тот же шаг, что отказал в коде из приложения).
    const recovered = await c.post('/api/auth/login/recovery', { code: recoveryCodes[0] }).expect(200);
    expect(recovered.body.me.amr).toEqual(['pwd', 'recovery']);
  });

  it('суточный лимит при политике «всегда спрашивать код»: отказ не обещает вход с запомненного устройства', async () => {
    const policy = app.get(SecurityPolicyStore);
    await valkey.set('throttle:2fa:admin', '20', 'EX', 3600);
    await policy.set({ alwaysAskTotp: true });
    try {
      const c = await newClient('198.51.100.27');
      await login(c).expect(200);
      const closed = await c.post('/api/auth/login/totp', { code: await code() });
      expect(closed.status).toBe(429);
      expect(closed.body.type).toBe(AUTH_PROBLEM.codeEntryClosed);
      expect(closed.body.detail).toContain('Войдите по коду восстановления.');
      expect(closed.body.detail).not.toContain('запомненного');
    } finally {
      await policy.set({ alwaysAskTotp: false });
    }
  });

  /* ---------- x-db#3: анонимные запросы и Журнал ---------- */

  it('поток запросов без CSRF-токена: не больше пяти записей с адреса за минуту и сводка; путь обрезан', async () => {
    await awayFromMinuteEdge();
    const ip = '198.51.100.30';
    const junk = `/api/settings/appearance?${'a'.repeat(6000)}`;
    for (let i = 0; i < 25; i++)
      await request(base).post(junk).set('X-Forwarded-For', ip).send({}).expect(403);

    const rows = await settle('auth.csrf.denied');
    expect(rows).toHaveLength(5);
    for (const r of rows) {
      expect(r.ip).toBe(ip);
      expect(String(r.metadata.path).length).toBeLessThanOrEqual(200);
      expect(String(r.metadata.path).startsWith('/api/settings/appearance?aaa')).toBe(true);
    }
    expect(await journal('auth.denied.summary')).toHaveLength(0);
    await app.get(AnonAuditLimiter).flush();
    const summary = await journal('auth.denied.summary');
    expect(summary).toHaveLength(1);
    expect(summary[0]?.metadata.note).toBe(
      'Отклонено запросов без входа: ещё 20. По одному они не записаны.',
    );
  });

  it('запросы без входа (с CSRF-токеном) — под тем же лимитом, вместе с отказами по CSRF', async () => {
    await awayFromMinuteEdge();
    const c = await newClient('198.51.100.31');
    for (let i = 0; i < 4; i++)
      await c.post('/api/servers/00000000-0000-4000-8000-000000000000/check').expect(401);
    for (let i = 0; i < 4; i++)
      await request(base).post('/api/settings/appearance').set('X-Forwarded-For', c.ip).send({}).expect(403);
    const denied = await journal('auth.request.denied');
    const csrf = await settle('auth.csrf.denied');
    expect(denied).toHaveLength(4);
    expect(denied[0]?.metadata).toMatchObject({ reason: 'unauthenticated', method: 'POST' });
    expect(csrf).toHaveLength(1);
    await app.get(AnonAuditLimiter).flush();
    expect(skippedIn(await journal('auth.denied.summary'))).toBe(3);
  });

  it('много адресов сразу: общий потолок тридцать записей в минуту, Журнал не заполнить', async () => {
    await awayFromMinuteEdge();
    for (let i = 1; i <= 40; i++)
      await request(base)
        .post('/api/settings/appearance')
        .set('X-Forwarded-For', `198.51.101.${i}`)
        .send({})
        .expect(403);
    expect(await settle('auth.csrf.denied')).toHaveLength(30);
    await app.get(AnonAuditLimiter).flush();
    expect(skippedIn(await journal('auth.denied.summary'))).toBe(10);
  });

  it('перебор логинов с многих адресов: записей о неудачных попытках не больше тридцати в минуту, остальное — в сводке', async () => {
    await awayFromMinuteEdge();
    // 8 адресов по 4 неудачи (паузы не включаются) = 32 попытки, и ещё одна — по настоящему логину
    for (let a = 1; a <= 8; a++) {
      const c = await newClient(`198.51.102.${a}`);
      for (let i = 1; i <= 4; i++) await login(c, WRONG, `ghost-${a}-${i}`).expect(401);
    }
    await login(await newClient('198.51.102.99'), WRONG).expect(401);
    expect(await journal('auth.login.failed')).toHaveLength(30);

    await app.get(AnonAuditLimiter).flush();
    const summary = await journal('auth.denied.summary');
    expect(summary.map((r) => r.metadata.note)).toEqual([
      'Записей о неудачных попытках входа: ещё 3. По одной они не записаны.',
    ]);
  });

  it('логин с управляющими символами: обычный отказ без ошибки сервера, в Журнале — без них', async () => {
    const c = await newClient('198.51.100.33');
    // нулевой символ базе передавать нельзя (ошибка запроса), битый суррогат ломает запись в Журнал
    for (const name of ['ad\u0000min', 'x\ud800y']) {
      const res = await login(c, WRONG, name);
      expect(res.status).toBe(401);
      expect(res.body.type).toBe(AUTH_PROBLEM.invalidCredentials);
    }
    const rows = await journal('auth.login.failed');
    expect(rows.map((r) => r.metadata.login)).toEqual(['ad min', 'x y']);
    expect(rows.map((r) => r.actor_display)).toEqual(['ad min', 'x y']);
  });

  it('идентификатор запроса из заголовка принимается только в формате UUID', async () => {
    // Запрос без входа доходит до Журнала вместе с идентификатором — мусор из заголовка туда не попадает.
    const c = await newClient('198.51.100.32');
    const junk = await c
      .post('/api/servers/00000000-0000-4000-8000-000000000000/check')
      .set('X-Request-Id', 'x'.repeat(4000))
      .expect(401);
    expect(junk.body.requestId).toMatch(UUID);
    const [row] = await journal('auth.request.denied');
    expect(row?.request_id).toBe(junk.body.requestId);

    const own = await request(base)
      .get('/api/auth/me')
      .set('X-Request-Id', '3F2504E0-4F89-41D3-9A0C-0305E82C3301')
      .expect(401);
    expect(own.body.requestId).toBe('3f2504e0-4f89-41d3-9a0c-0305e82c3301');
  });

  /* ---------- x-security#9: попытка занимается до хеширования ---------- */

  it('залп параллельных попыток: пароль проверяется не больше пяти раз, остальные получают отказ без хеширования', async () => {
    const verify = vi.spyOn(app.get(CryptoService), 'verifyAgainstDummy');
    try {
      const c = await newClient('198.51.100.40');
      const all = await Promise.all(Array.from({ length: 20 }, () => login(c, WRONG, 'ghost')));
      expect(verify).toHaveBeenCalledTimes(5);
      const statuses = all.map((r) => r.status);
      expect(statuses.filter((s) => s === 401)).toHaveLength(4);
      expect(statuses.filter((s) => s === 429)).toHaveLength(16);
      // пауза включилась один раз: серия первая, 30 с
      expect(await journal('auth.login.throttled')).toHaveLength(1);
      expect((await login(c, WRONG, 'ghost')).body.retryAfterSeconds).toBeLessThanOrEqual(30);
    } finally {
      verify.mockRestore();
    }
  });

  it('очередь проверок пароля переполнена — отказ сразу, без хеширования и без счёта неудачи; запомненное устройство проходит', async () => {
    const owner = await newClient('192.0.2.30');
    await fullLogin(owner, true);
    await owner.post('/api/auth/logout').expect(204);

    const crypto = app.get(CryptoService);
    const waiting = vi.spyOn(crypto, 'passwordChecksWaiting', 'get').mockReturnValue(99);
    const verify = vi.spyOn(crypto, 'verifyPassword');
    try {
      const c = await newClient('198.51.100.41');
      const busy = await login(c);
      expect(busy.status).toBe(429);
      expect(busy.body.type).toBe(AUTH_PROBLEM.busy);
      expect(busy.body.detail).toContain('Подождите несколько секунд');
      expect(verify).not.toHaveBeenCalled();
      // владельца с запомненного устройства залп чужих попыток из очереди не вытесняет
      expect((await login(owner).expect(200)).body.next).toBe('done');
      waiting.mockRestore();
      // отказ «занято» — не неудача: следом с того же адреса вход идёт как обычно
      expect((await login(c).expect(200)).body).toEqual({ next: 'totp' });
    } finally {
      waiting.mockRestore();
      verify.mockRestore();
    }
  });

  it('IPv6: адреса одной сети /64 делят одну паузу', async () => {
    const net = '2001:db8:abcd:12';
    for (let i = 1; i <= 4; i++)
      await login(await newClient(`${net}::${i}`), WRONG, `ghost-${i}`).expect(401);
    await login(await newClient(`${net}:aaaa:bbbb:cccc:dddd`), WRONG, 'ghost-5').expect(429);
    // другой адрес той же сети — на паузе даже с верным паролем; соседняя сеть — нет
    await login(await newClient(`${net}::ffff`)).expect(429);
    await login(await newClient('2001:db8:abcd:13::1')).expect(200);
  });

  /* ---------- api-platform#8: вход по коду восстановления ---------- */

  it('вход по коду восстановления присылает уведомление в колокольчик и Telegram с числом оставшихся кодов', async () => {
    const c = await newClient('198.51.100.50');
    await login(c).expect(200);
    const res = await c.post('/api/auth/login/recovery', { code: recoveryCodes[1] }).expect(200);
    const left = res.body.recoveryCodesLeft as number;

    const sent = alerts();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      title: 'Вход по коду восстановления',
      severity: 'warn',
      telegram: { event: 'login' },
    });
    expect(sent[0]?.body).toContain(`Кодов восстановления осталось: ${left}`);
    expect(sent[0]?.body).toContain('Адрес 198.51.100.50');
    expect(sent[0]?.body).toContain('Остальные сессии завершены');
    // «вход с нового устройства» отдельно не приходит — одно сообщение на один вход
    expect(pushed().filter((p) => p.title === NEW_DEVICE)).toHaveLength(0);
    // колокольчик
    const bell = await app.get(NotificationsService).list();
    expect(bell.items.some((n) => n.title === 'Вход по коду восстановления')).toBe(true);
  });

  /* ---------- api-platform#7: владелец не заперт чужими неудачами ---------- */

  it('чужие неудачи по логину не держат запомненное устройство и экран блокировки', async () => {
    const owner = await newClient('192.0.2.20');
    await fullLogin(owner, true);
    await owner.post('/api/auth/lock').expect(204);

    await wrongSeries(await newClient('198.51.100.60'));
    // новое устройство даже с верным паролем ждёт паузу по логину — защита на месте
    const stranger = await newClient('198.51.100.61');
    await login(stranger).expect(429);

    // экран блокировки открывается
    await owner.post('/api/auth/unlock', { password: PASSWORD }).expect(200);
    await owner.post('/api/auth/logout').expect(204);
    // запомненное устройство входит
    const back = await login(owner).expect(200);
    expect(back.body.next).toBe('done');
    expect(back.body.me.amr).toEqual(['pwd', 'trusted']);
    // вход владельца не снял паузу для остальных
    await login(stranger).expect(429);
  });

  it('запомненное устройство — не обход: свои пять неудач включают паузу для него самого, остальным не мешают', async () => {
    const owner = await newClient('192.0.2.21');
    await fullLogin(owner, true);
    await owner.post('/api/auth/logout').expect(204);
    push.mockClear();

    await wrongSeries(owner);
    await login(owner).expect(429);
    expect(alerts()[0]?.body).toContain('Вход с этого устройства и с этого адреса приостановлен на 30 с');
    // пауза — у устройства и его адреса, по логину с других мест вход открыт
    const other = await login(await newClient('198.51.100.62')).expect(200);
    expect(other.body).toEqual({ next: 'totp' });
  });

  it('«всегда спрашивать код»: запомненное устройство проходит оба шага, пока по логину идёт чужая пауза', async () => {
    const policy = app.get(SecurityPolicyStore);
    const owner = await newClient('192.0.2.22');
    await fullLogin(owner, true);
    await owner.post('/api/auth/logout').expect(204);
    await policy.set({ alwaysAskTotp: true });
    try {
      await wrongSeries(await newClient('198.51.100.63'));
      expect((await login(owner).expect(200)).body).toEqual({ next: 'totp' });
      await owner.post('/api/auth/login/totp', { code: await code() }).expect(200);
    } finally {
      await policy.set({ alwaysAskTotp: false });
    }
  });

  it('экран блокировки: пять неверных паролей — пауза для этой сессии; вход по логину с других устройств не страдает', async () => {
    const owner = await newClient('192.0.2.23');
    await fullLogin(owner);
    await owner.post('/api/auth/lock').expect(204);
    push.mockClear();

    for (let i = 0; i < 4; i++) await owner.post('/api/auth/unlock', { password: WRONG }).expect(401);
    await owner.post('/api/auth/unlock', { password: WRONG }).expect(429);
    await owner.post('/api/auth/unlock', { password: PASSWORD }).expect(429);

    const sent = alerts();
    expect(sent).toHaveLength(1);
    expect(sent[0]?.body).toContain('на экране блокировки пароль не подошёл');
    expect(sent[0]?.body).toContain('Разблокировка в этой сессии и с этого адреса приостановлена на 30 с');
    // по логину с другого адреса вход открыт
    expect((await login(await newClient('198.51.100.64')).expect(200)).body).toEqual({ next: 'totp' });
    // пауза прошла — разблокировка работает
    await endPauses();
    await owner.post('/api/auth/unlock', { password: PASSWORD }).expect(200);
  });

  /* ---------- смена пароля из открытой сессии ---------- */

  it('чужая пауза по логину не мешает сменить пароль из открытой сессии: совет «смените пароль» выполним', async () => {
    const owner = await newClient('192.0.2.24');
    await fullLogin(owner);
    // Посторонний знает пароль и перебирает коды: по логину пауза, владельцу пришло «смените пароль».
    const attacker = await newClient('198.51.100.65');
    await login(attacker).expect(200);
    for (let i = 0; i < 5; i++) await attacker.post('/api/auth/login/totp', { code: '000000' });
    await login(attacker).expect(429);
    expect(alerts()[0]?.body).toContain('Если это не вы — смените пароль');

    const temporary = 'another long passphrase 42';
    await owner
      .post('/api/security/password', { currentPassword: PASSWORD, newPassword: temporary })
      .expect(200);
    // вернуть прежний пароль — на нём держатся остальные тесты
    await owner
      .post('/api/security/password', { currentPassword: temporary, newPassword: PASSWORD })
      .expect(200);
  });

  it('смена пароля: залп запросов с неверным текущим паролем — не больше пяти проверок, пауза общая с экраном блокировки', async () => {
    const owner = await newClient('192.0.2.25');
    await fullLogin(owner);
    const verify = vi.spyOn(app.get(CryptoService), 'verifyPassword');
    try {
      const all = await Promise.all(
        Array.from({ length: 20 }, () =>
          owner.post('/api/security/password', {
            currentPassword: WRONG,
            newPassword: 'another long passphrase 42',
          }),
        ),
      );
      expect(verify).toHaveBeenCalledTimes(5);
      expect(all.filter((r) => r.status === 401)).toHaveLength(4);
      expect(all.filter((r) => r.status === 429)).toHaveLength(16);
    } finally {
      verify.mockRestore();
    }
    // Подбор пароля из этой сессии приостановлен целиком: и смена пароля, и разблокировка экрана.
    await owner.post('/api/auth/lock').expect(204);
    await owner.post('/api/auth/unlock', { password: PASSWORD }).expect(429);
    // А вход по логину с других устройств открыт: пауза — у сессии и её адреса.
    expect((await login(await newClient('198.51.100.66')).expect(200)).body).toEqual({ next: 'totp' });
  });

  /* ---------- в настоящем времени, без «перемотки» ---------- */

  it('пауза кончается сама: через полминуты вход снова работает, а сводку отказов к этому времени записал таймер', async () => {
    const c = await newClient('198.51.100.70');
    await wrongSeries(c);
    for (let i = 0; i < 3; i++) await login(c).expect(429);
    const retry = (await login(c).expect(429)).body.retryAfterSeconds as number;
    expect(retry).toBeLessThanOrEqual(30);
    await new Promise((r) => setTimeout(r, retry * 1000 + 300));

    expect((await login(c).expect(200)).body).toEqual({ next: 'totp' });
    let summary: JournalRow[] = [];
    for (let i = 0; i < 50 && summary.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 100));
      summary = await journal('auth.login.rejected');
    }
    expect(summary).toHaveLength(1);
    expect(summary[0]?.metadata.note).toBe('Отклонено попыток: 4');
  }, 60_000);
});
