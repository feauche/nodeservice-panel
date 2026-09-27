import type { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import {
  CSRF_HEADER,
  type RemnawaveCert,
  type RemnawaveStatus,
  remnawaveStatusSchema,
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
import { RemnawaveService } from '../src/modules/remnawave/remnawave.service.js';
import {
  REMNAWAVE_CLIENT,
  RemnawaveApiError,
  type RemnawaveClient,
} from '../src/modules/remnawave/remnawave-client.js';

const LOGIN = 'admin';
const PASSWORD = 'correct horse battery staple';

if (!process.env.DATABASE_URL?.endsWith('/nodeservice_test'))
  throw new Error('e2e: DATABASE_URL должен указывать на nodeservice_test');

const CERT_OK: RemnawaveCert = {
  status: 'ok',
  expiresAt: '2027-01-01T00:00:00.000Z',
  daysLeft: 90,
  note: null,
};

/** Как GEO_LOOKUP в server-country.e2e-spec.ts: подменяем внешний клиент целиком, сеть не трогаем. */
class FakeRemnawaveClient implements RemnawaveClient {
  goodToken = 'rw_pat_good';
  usersOnline = 42;
  nodesOnline = 1;
  down = false;
  cert: RemnawaveCert = CERT_OK;
  domainsAsked: string[] = [];

  async fetch(domain: string, apiKey: string) {
    this.domainsAsked.push(domain);
    if (domain === 'unreachable.example.com' || this.down)
      throw new RemnawaveApiError('Remnawave не отвечает.', 'unreachable');
    if (apiKey !== this.goodToken)
      throw new RemnawaveApiError('Remnawave ответила «доступ запрещён».', 'unauthorized');
    return {
      stats: {
        users: { total: 870, active: 800, disabled: 40, limited: 10, expired: 20 },
        online: { now: this.usersOnline, lastDay: 500, lastWeek: 700, never: 10 },
        nodesOnline: this.nodesOnline,
        nodesTotal: 1,
        trafficBytesLifetime: '20000000000000',
        panelVersion: '2.1.10',
        panelUptimeSec: 12_345,
      },
      nodes: [
        {
          uuid: 'n1',
          name: 'bridge',
          address: '104.171.133.254',
          countryCode: 'PL',
          isConnected: true,
          isDisabled: false,
          isConnecting: false,
          lastStatusMessage: null,
          usersOnline: this.usersOnline,
          trafficUsedBytes: 1000,
          trafficLimitBytes: null,
        },
      ],
    };
  }

  async checkCertificate(): Promise<RemnawaveCert> {
    return this.cert;
  }
}

describe('Remnawave e2e (J4)', () => {
  let app: INestApplication;
  let agent: InstanceType<typeof TestAgent>;
  let csrf: string;
  const fake = new FakeRemnawaveClient();

  const status = async (): Promise<RemnawaveStatus> =>
    remnawaveStatusSchema.parse((await agent.get('/api/remnawave/status').expect(200)).body);
  const auditActions = async () =>
    JSON.stringify((await agent.get('/api/audit?pageSize=50').expect(200)).body);

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(REMNAWAVE_CLIENT)
      .useValue(fake)
      .compile();
    app = moduleRef.createNestApplication<NestExpressApplication>({ bufferLogs: false, logger: false });
    setupHttp(app as NestExpressApplication);
    const db = app.get<Db>(DB);
    await runMigrations(db);
    await db.execute(sql`truncate users, recovery_codes, trusted_devices, setup_tokens cascade`);
    await db.execute(sql`delete from app_meta where key like 'settings.%'`);
    await app.get<Redis>(VALKEY).flushdb();
    await app.init();
    agent = request.agent(app.getHttpServer());
    csrf = (await agent.get('/api/auth/csrf').expect(200)).body.token as string;
    const setupToken = await app.get(SetupService).issueToken();
    const start = await agent
      .post('/api/auth/setup/start')
      .set(CSRF_HEADER, csrf)
      .send({ setupToken, login: LOGIN, password: PASSWORD })
      .expect(200);
    await agent
      .post('/api/auth/setup/confirm')
      .set(CSRF_HEADER, csrf)
      .send({ code: await generate({ secret: start.body.totpSecret as string }) })
      .expect(200);
  }, 120_000);

  afterAll(async () => {
    await app?.close();
  });

  it('не подключено изначально', async () => {
    expect(await status()).toEqual({
      connected: false,
      domain: null,
      checkedAt: null,
      error: null,
      stats: null,
      nodes: [],
      cert: null,
    });
  });

  it('без входа недоступно', async () => {
    const anon = request(app.getHttpServer());
    await anon.get('/api/remnawave/status').expect(401);
  });

  it('неверный токен: 400, ничего не подключается', async () => {
    const res = await agent
      .post('/api/remnawave/connect')
      .set(CSRF_HEADER, csrf)
      .send({ domain: 'vpn-panel.example.com', apiKey: 'rw_pat_bad' })
      .expect(400);
    expect(JSON.stringify(res.body)).toContain('доступ запрещён');
    expect((await status()).connected).toBe(false);
  });

  it('домен не отвечает: 502', async () => {
    await agent
      .post('/api/remnawave/connect')
      .set(CSRF_HEADER, csrf)
      .send({ domain: 'unreachable.example.com', apiKey: 'rw_pat_good' })
      .expect(502);
  });

  it('успешное подключение: домен нормализован (без протокола и хвостового слэша), сводка, нода, версия панели; запись в Журнале', async () => {
    const res = await agent
      .post('/api/remnawave/connect')
      .set(CSRF_HEADER, csrf)
      .send({ domain: 'https://VPN-Panel.example.com/', apiKey: 'rw_pat_good' })
      .expect(200);
    const s = remnawaveStatusSchema.parse(res.body);
    expect(s.domain).toBe('VPN-Panel.example.com');
    expect(fake.domainsAsked.at(-1)).toBe('VPN-Panel.example.com');
    expect(s.connected).toBe(true);
    expect(s.stats).toMatchObject({ users: { total: 870 }, panelVersion: '2.1.10' });
    expect(s.nodes).toEqual([
      {
        uuid: 'n1',
        name: 'bridge',
        address: '104.171.133.254',
        countryCode: 'PL',
        isConnected: true,
        isDisabled: false,
        isConnecting: false,
        lastStatusMessage: null,
        usersOnline: 42,
        trafficUsedBytes: 1000,
        trafficLimitBytes: null,
      },
    ]);
    expect(s.cert).toEqual(CERT_OK);
    expect(await auditActions()).toContain('remnawave.connected');
  });

  it('обновить: свежие цифры без повторной отправки токена', async () => {
    fake.usersOnline = 55;
    const res = await agent.post('/api/remnawave/refresh').set(CSRF_HEADER, csrf).expect(200);
    expect(remnawaveStatusSchema.parse(res.body).stats?.online.now).toBe(55);
    fake.usersOnline = 42;
  });

  it('плановая перепроверка (джоба): недоступность и восстановление отражаются в статусе и Журнале', async () => {
    const svc = app.get(RemnawaveService);
    fake.down = true;
    await svc.syncQuiet();
    let s = await status();
    expect(s.connected).toBe(true);
    expect(s.error).toBeTruthy();
    expect(s.stats?.users.total).toBe(870); // прежние данные не потерялись
    expect(await auditActions()).toContain('remnawave.unreachable');
    fake.down = false;
    await svc.syncQuiet();
    s = await status();
    expect(s.error).toBeNull();
    expect(await auditActions()).toContain('remnawave.reconnected');
  });

  it('отключение стирает всё, запись в Журнале', async () => {
    await agent.delete('/api/remnawave').set(CSRF_HEADER, csrf).expect(204);
    expect(await status()).toMatchObject({ connected: false });
    expect(await auditActions()).toContain('remnawave.disconnected');
  });

  it('неверный формат запроса на подключение отклоняется 400', async () => {
    for (const bad of [{ domain: 'x' }, { apiKey: 'k' }, { domain: '', apiKey: '' }])
      expect([400, 422]).toContain(
        (await agent.post('/api/remnawave/connect').set(CSRF_HEADER, csrf).send(bad)).status,
      );
  });
});
