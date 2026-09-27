import type { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import {
  CSRF_HEADER,
  incidentsListResponseSchema,
  type RemnawaveCert,
  serverSchema,
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
import { NodeAnomalyJob } from '../src/modules/incidents/node-anomaly.job.js';
import { RemnawaveService } from '../src/modules/remnawave/remnawave.service.js';
import {
  REMNAWAVE_CLIENT,
  type RemnawaveClient,
  type RemnawaveNodeInbound,
} from '../src/modules/remnawave/remnawave-client.js';
import { FakeSsh, SSH_PASSWORD, SSH_USER } from './fake-ssh.js';

if (!process.env.DATABASE_URL?.endsWith('/nodeservice_test'))
  throw new Error('e2e: DATABASE_URL должен указывать на nodeservice_test');

const LOGIN = 'admin';
const PASSWORD = 'correct horse battery staple';

const CERT_OK: RemnawaveCert = {
  status: 'ok',
  expiresAt: '2027-01-01T00:00:00.000Z',
  daysLeft: 90,
  note: null,
};

/** Та же нода Remnawave, что и в жизни: онлайн и время снимка меняются между вызовами fetch(). */
class FakeRemnawaveClient implements RemnawaveClient {
  usersOnline = 100;
  inbound: RemnawaveNodeInbound | null = { sni: 'www.example.com', port: 8443 };

  async fetch() {
    return {
      stats: {
        users: { total: 100, active: 100, disabled: 0, limited: 0, expired: 0 },
        online: { now: this.usersOnline, lastDay: 100, lastWeek: 100, never: 0 },
        nodesOnline: 1,
        nodesTotal: 1,
        trafficBytesLifetime: '0',
        panelVersion: '2.1.10',
        panelUptimeSec: 1,
      },
      nodes: [
        {
          uuid: 'node-1',
          name: 'проверяемая-нода',
          address: '198.51.100.9',
          countryCode: 'DE',
          isConnected: true,
          isDisabled: false,
          isConnecting: false,
          lastStatusMessage: null,
          usersOnline: this.usersOnline,
          trafficUsedBytes: 0,
          trafficLimitBytes: null,
        },
      ],
    };
  }

  async checkCertificate(): Promise<RemnawaveCert> {
    return CERT_OK;
  }

  async findNodeInbound(): Promise<RemnawaveNodeInbound | null> {
    return this.inbound;
  }
}

/**
 * J10 целиком: тик аномалии сравнивает два снимка Remnawave, находит резкое падение онлайна, просит
 * NodeBlockCheckService проверить блокировку с российского сервера парка по SSH (тот же способ, что
 * и встречные проверки доступности) и заводит инцидент только по результату этой проверки.
 */
describe('J10: аномалия онлайна → проверка блокировки → инцидент (e2e)', () => {
  let app: INestApplication;
  let agent: InstanceType<typeof TestAgent>;
  let csrf: string;
  const ssh = new FakeSsh();
  const fake = new FakeRemnawaveClient();

  beforeAll(async () => {
    await ssh.start();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(REMNAWAVE_CLIENT)
      .useValue(fake)
      .compile();
    app = moduleRef.createNestApplication<NestExpressApplication>({ bufferLogs: false, logger: false });
    setupHttp(app as NestExpressApplication);
    const db = app.get<Db>(DB);
    await runMigrations(db);
    await db.execute(
      sql`truncate users, recovery_codes, trusted_devices, setup_tokens, servers, incidents cascade`,
    );
    await db.execute(sql`delete from app_meta where key like 'settings.%' or key = 'panel.ssh-key'`);
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

    const created = await agent
      .post('/api/servers')
      .set(CSRF_HEADER, csrf)
      .send({
        name: 'ru-probe',
        host: '127.0.0.1',
        port: ssh.port,
        sshUser: SSH_USER,
        auth: { method: 'password', password: SSH_PASSWORD },
        country: { mode: 'manual', code: 'RU' },
      })
      .expect(201);
    serverSchema.parse(created.body);

    await agent
      .post('/api/remnawave/connect')
      .set(CSRF_HEADER, csrf)
      .send({ domain: 'vpn-panel.example.com', apiKey: 'whatever' })
      .expect(200);
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await ssh.stop();
  });

  it('первый тик — только базовый снимок, инцидента ещё нет', async () => {
    await app.get(NodeAnomalyJob).run();
    const list = incidentsListResponseSchema.parse(
      (await agent.get('/api/incidents?status=open').expect(200)).body,
    );
    expect(list.items.some((i) => i.kind === 'node_blocked')).toBe(false);
  });

  it('падение онлайна на 90% + тихий обрыв на этапе TLS с российского сервера парка → «похоже на ТСПУ»', async () => {
    fake.usersOnline = 10;
    ssh.blockCheckOutput = '{"stage":"tls","ok":false,"stalledAtKb":null}';
    await app.get(RemnawaveService).refresh();
    await app.get(NodeAnomalyJob).run();

    const list = incidentsListResponseSchema.parse(
      (await agent.get('/api/incidents?status=open').expect(200)).body,
    );
    const inc = list.items.find((i) => i.kind === 'node_blocked');
    expect(inc).toBeTruthy();
    expect(inc?.severity).toBe('crit');
    expect(inc?.title).toContain('ТСПУ');
    expect(inc?.title).toContain('проверяемая-нода');
    expect(inc?.detail).toContain('ru-probe');
    expect(inc?.detail).toContain('упал с 100 до 10');
    expect(inc?.detail).toContain('90');
    expect(inc?.timeline[0]?.result).toBe('detect');
  });
});
