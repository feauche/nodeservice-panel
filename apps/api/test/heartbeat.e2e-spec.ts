import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import type { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import {
  AUTH_PROBLEM,
  CSRF_HEADER,
  HEARTBEAT_PROBLEM,
  heartbeatTestResponseSchema,
  heartbeatViewSchema,
  SHARED_VERSION,
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
import { SetupService } from '../src/modules/auth/setup.service.js';
import { HeartbeatService } from '../src/modules/health/heartbeat.service.js';
import { PanelPulse } from '../src/modules/health/panel-pulse.js';
import { listenLocal } from './listen-local.js';

if (!process.env.DATABASE_URL?.endsWith('/nodeservice_test'))
  throw new Error('e2e: DATABASE_URL должен указывать на nodeservice_test');

/** Ключ сервиса в пути — как у Healthchecks.io: в Журнал он попадать не должен. */
const SECRET = '5b4e6c8a-1d2f-4c3b-9a8e-7f6d5c4b3a21';

/** Поддельный сервис проверки на 127.0.0.1: /ok — 200, /missing — 404, /moved — переход на /ok. */
class FakeService {
  hits: Array<{ path: string; ua: string }> = [];
  private server: Server = createServer((req, res) => {
    this.hits.push({ path: req.url ?? '', ua: String(req.headers['user-agent'] ?? '') });
    if (req.url?.startsWith('/moved')) {
      res.writeHead(302, { location: `/ok/${SECRET}` }).end();
      return;
    }
    res.writeHead(req.url?.startsWith('/ok') ? 200 : 404).end('OK');
  });
  base = '';

  async start(): Promise<void> {
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    this.base = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }
  stop(): Promise<void> {
    return new Promise((resolve) => this.server.close(() => resolve()));
  }
}

describe('сигнал «панель жива» e2e', () => {
  let app: INestApplication;
  let agent: InstanceType<typeof TestAgent>;
  let csrf: string;
  const fake = new FakeService();

  beforeAll(async () => {
    await fake.start();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication<NestExpressApplication>({ bufferLogs: false, logger: false });
    setupHttp(app as NestExpressApplication);
    const db = app.get<Db>(DB);
    await runMigrations(db);
    await db.execute(sql`truncate users, recovery_codes, trusted_devices, setup_tokens cascade`);
    await db.execute(sql`delete from app_meta where key like 'settings.%'`);
    await app.get<Redis>(VALKEY).flushdb();
    await listenLocal(app);
    agent = request.agent(app.getHttpServer());
    csrf = (await agent.get('/api/auth/csrf').expect(200)).body.token as string;
    const setupToken = await app.get(SetupService).issueToken();
    const start = await agent
      .post('/api/auth/setup/start')
      .set(CSRF_HEADER, csrf)
      .send({ setupToken, login: 'admin', password: 'correct horse battery staple' })
      .expect(200);
    await agent
      .post('/api/auth/setup/confirm')
      .set(CSRF_HEADER, csrf)
      .send({ code: await generate({ secret: start.body.totpSecret as string }) })
      .expect(200);
    app.get(PanelPulse).incidentsTick();
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await fake.stop();
  });

  const waitFor = async (check: () => boolean, what: string) => {
    for (let i = 0; i < 50; i += 1) {
      if (check()) return;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`не дождались: ${what}`);
  };

  it('без входа — 401; по умолчанию сигнал выключен', async () => {
    const anon = await request(app.getHttpServer()).get('/api/settings/heartbeat').expect(401);
    expect(anon.body.type).toBe(AUTH_PROBLEM.unauthenticated);
    const view = heartbeatViewSchema.parse((await agent.get('/api/settings/heartbeat').expect(200)).body);
    expect(view).toEqual({
      url: '',
      status: {
        everySeconds: 60,
        lastAttemptAt: null,
        lastOkAt: null,
        lastResult: null,
        consecutiveFailures: 0,
        recent: [],
      },
    });
  });

  it('неверный адрес — 400 с ошибкой у поля по-русски', async () => {
    const res = await agent
      .put('/api/settings/heartbeat')
      .set(CSRF_HEADER, csrf)
      .send({ url: 'ftp://hc-ping.com/x' })
      .expect(400);
    expect(JSON.stringify(res.body)).toContain('Адрес должен начинаться с https:// или http://');
  });

  it('сохранили адрес — сразу первый сигнал с версией панели; в Журнале только хост, без ключа', async () => {
    const url = `${fake.base}/ok/${SECRET}`;
    const saved = heartbeatViewSchema.parse(
      (await agent.put('/api/settings/heartbeat').set(CSRF_HEADER, csrf).send({ url }).expect(200)).body,
    );
    expect(saved.url).toBe(url);
    await waitFor(() => fake.hits.length >= 1, 'первый сигнал');
    expect(fake.hits[0]).toEqual({ path: `/ok/${SECRET}`, ua: `nodeservice-panel/${SHARED_VERSION}` });
    await waitFor(() => app.get(HeartbeatService).status().lastResult !== null, 'итог сигнала');
    const view = heartbeatViewSchema.parse((await agent.get('/api/settings/heartbeat').expect(200)).body);
    expect(view.status.lastResult).toMatchObject({ ok: true, sent: true, httpStatus: 200, problem: null });
    expect(view.status.lastOkAt).not.toBeNull();

    const audit = await agent.get('/api/audit?action=settings.heartbeat.updated').expect(200);
    const text = JSON.stringify(audit.body);
    expect(text).toContain('адрес задан');
    expect(text).toContain(new URL(fake.base).host);
    expect(text).not.toContain(SECRET);
  });

  it('очередной сигнал: готова — шлёт; поиск событий встал — не шлёт и пишет почему', async () => {
    const svc = app.get(HeartbeatService);
    const pulse = app.get(PanelPulse);
    const before = fake.hits.length;
    await svc.beat();
    expect(fake.hits).toHaveLength(before + 1);

    pulse.incidentsTick(Date.now() - 6 * 60_000);
    await svc.beat();
    expect(fake.hits).toHaveLength(before + 1);
    expect(svc.status().lastResult).toMatchObject({
      ok: false,
      sent: false,
      problem: 'не отправлен: поиск инцидентов не отрабатывал 6 мин',
    });
    expect(svc.status().consecutiveFailures).toBe(1);
    pulse.incidentsTick();
  });

  it('проверка: другой адрес — его итог (404), состояние сохранённого не трогает; чаще раза в 5 с — 429', async () => {
    const statusBefore = app.get(HeartbeatService).status();
    const res = heartbeatTestResponseSchema.parse(
      (
        await agent
          .post('/api/settings/heartbeat/test')
          .set(CSRF_HEADER, csrf)
          .send({ url: `${fake.base}/missing/${SECRET}` })
          .expect(200)
      ).body,
    );
    expect(res).toMatchObject({
      ok: false,
      httpStatus: 404,
      problem: 'сервис ответил 404',
      ready: true,
      notReady: [],
    });
    expect(app.get(HeartbeatService).status()).toEqual(statusBefore);

    const again = await agent
      .post('/api/settings/heartbeat/test')
      .set(CSRF_HEADER, csrf)
      .send({})
      .expect(429);
    expect(again.body.type).toBe(HEARTBEAT_PROBLEM.tooOften);

    const audit = await agent.get('/api/audit?action=settings.heartbeat.test').expect(200);
    expect(JSON.stringify(audit.body)).not.toContain(SECRET);
  });

  it('переход сервиса на другой путь — сигнал засчитан', async () => {
    const svc = app.get(HeartbeatService);
    await agent
      .put('/api/settings/heartbeat')
      .set(CSRF_HEADER, csrf)
      .send({ url: `${fake.base}/moved/${SECRET}` })
      .expect(200);
    await waitFor(() => svc.status().lastResult !== null, 'итог после смены адреса');
    expect(svc.status().lastResult).toMatchObject({ ok: true, httpStatus: 200 });
    expect(fake.hits.slice(-2).map((h) => h.path)).toEqual([`/moved/${SECRET}`, `/ok/${SECRET}`]);
  });

  it('выключили — адрес пуст, сигналов больше нет', async () => {
    const view = heartbeatViewSchema.parse(
      (await agent.put('/api/settings/heartbeat').set(CSRF_HEADER, csrf).send({ url: '' }).expect(200)).body,
    );
    expect(view.url).toBe('');
    expect(view.status.lastResult).toBeNull();
    const before = fake.hits.length;
    await app.get(HeartbeatService).beat();
    expect(fake.hits).toHaveLength(before);
    const audit = await agent.get('/api/audit?action=settings.heartbeat.updated').expect(200);
    expect(JSON.stringify(audit.body)).toContain('адрес убран');
  });
});
