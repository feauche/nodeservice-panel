import { sign as edSign, generateKeyPairSync } from 'node:crypto';
import type { Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import {
  AGENT_MSG,
  AGENT_PROTOCOL_VERSION,
  type AgentEnvelope,
  agentEnrollResponseSchema,
  auditListResponseSchema,
  CSRF_HEADER,
  serverSchema,
} from '@nodeservice/shared';
import { sql } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import { generate } from 'otplib';
import request from 'supertest';
import TestAgent from 'supertest/lib/agent.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';

import { AppModule } from '../src/app.module.js';
import { setupHttp } from '../src/common/http/setup-http.js';
import { DB, type Db } from '../src/infra/db/db.module.js';
import { runMigrations } from '../src/infra/db/migrate.js';
import { VALKEY } from '../src/infra/valkey/valkey.module.js';
import { WsUpgradeService } from '../src/infra/ws/ws-upgrade.service.js';
import { AgentGateway } from '../src/modules/agent/agent.gateway.js';
import { SetupService } from '../src/modules/auth/setup.service.js';
import { FakeSsh, SSH_PASSWORD, SSH_USER } from './fake-ssh.js';

if (!process.env.DATABASE_URL?.endsWith('/nodeservice_test'))
  throw new Error('e2e: DATABASE_URL должен указывать на nodeservice_test');

const LOGIN = 'admin';
const PASSWORD = 'correct horse battery staple';

/** Клиент-агент для теста: очередь входящих конвертов + отправка. */
class WsAgent {
  ws!: WebSocket;
  private queue: AgentEnvelope[] = [];
  private waiters: Array<(env: AgentEnvelope) => void> = [];
  closed = false;

  async connect(url: string): Promise<void> {
    this.ws = new WebSocket(url);
    this.ws.on('message', (raw) => {
      const env = JSON.parse(String(raw)) as AgentEnvelope;
      const waiter = this.waiters.shift();
      if (waiter) waiter(env);
      else this.queue.push(env);
    });
    this.ws.on('close', () => {
      this.closed = true;
    });
    await new Promise<void>((resolve, reject) => {
      this.ws.once('open', resolve);
      this.ws.once('error', reject);
    });
  }

  send(type: string, payload: unknown): void {
    this.ws.send(
      JSON.stringify({
        v: AGENT_PROTOCOL_VERSION,
        type,
        id: crypto.randomUUID(),
        ts: new Date().toISOString(),
        payload,
      }),
    );
  }

  next(timeoutMs = 5_000): Promise<AgentEnvelope> {
    const fromQueue = this.queue.shift();
    if (fromQueue) return Promise.resolve(fromQueue);
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('нет сообщения от шлюза')), timeoutMs);
      this.waiters.push((env) => {
        clearTimeout(t);
        resolve(env);
      });
    });
  }
}

const METRICS = {
  cpuPct: 12.5,
  load1: 0.4,
  memUsedMb: 2048,
  memTotalMb: 8192,
  diskUsedMb: 10_000,
  diskTotalMb: 50_000,
  netRxBps: 1024,
  netTxBps: 2048,
  netRxPps: 10,
  netTxPps: 12,
  conntrackCount: 345,
  uptimeSec: 3600,
};

describe('agent e2e', () => {
  let app: INestApplication;
  let agent: InstanceType<typeof TestAgent>;
  let csrf: string;
  let wsBase = '';
  const ssh = new FakeSsh();
  let serverId = '';
  let token = '';

  const keys = generateKeyPairSync('ed25519');
  const pubkeyB64 = (keys.publicKey.export({ format: 'der', type: 'spki' }) as Buffer)
    .subarray(-32)
    .toString('base64');
  const signNonce = (nonceB64: string): string =>
    edSign(null, Buffer.from(nonceB64, 'base64'), keys.privateKey).toString('base64');

  beforeAll(async () => {
    await ssh.start();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication<NestExpressApplication>({ bufferLogs: false, logger: false });
    setupHttp(app as NestExpressApplication);
    const db = app.get<Db>(DB);
    await runMigrations(db);
    await db.execute(sql`truncate users, recovery_codes, trusted_devices, setup_tokens, servers cascade`);
    await db.execute(sql`delete from app_meta where key like 'settings.%' or key = 'panel.ssh-key'`);
    await app.get<Redis>(VALKEY).flushdb();
    await app.init();
    await app.listen(0);
    app.get(AgentGateway).register();
    app.get(WsUpgradeService).attach(app.getHttpServer() as HttpServer);
    const port = (app.getHttpServer().address() as AddressInfo).port;
    wsBase = `ws://127.0.0.1:${port}/api/agent/v1/ws`;

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

    // сервер + токен подключения агента
    const created = await agent
      .post('/api/servers')
      .set(CSRF_HEADER, csrf)
      .send({
        name: 'agent-host',
        host: '127.0.0.1',
        port: ssh.port,
        sshUser: SSH_USER,
        auth: { method: 'password', password: SSH_PASSWORD },
      })
      .expect(201);
    serverId = serverSchema.parse(created.body).id;
    // Автоустановка стартует фоном сразу после добавления — дождёмся, чтобы не гоняться за токенами.
    const deadline = Date.now() + 10_000;
    while (!ssh.execLog.some((c) => c.includes('install.sh')) && Date.now() < deadline)
      await new Promise((r) => setTimeout(r, 100));
    const issued = await agent
      .post(`/api/servers/${serverId}/enrollment-token`)
      .set(CSRF_HEADER, csrf)
      .expect(200);
    token = issued.body.token as string;
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await ssh.stop();
  });

  it('при добавлении сервера агент ставится автоматически: команда выполнена, статус и Журнал', async () => {
    expect(ssh.execLog.some((c) => c.includes('github.com/feauche/nodeservice-agent'))).toBe(true);
    const s = serverSchema.parse((await agent.get(`/api/servers/${serverId}`).expect(200)).body);
    expect(s.agentStatus).toBe('pending');
    const audit = auditListResponseSchema.parse(
      (await agent.get('/api/audit?category=server').expect(200)).body,
    );
    expect(audit.items.some((e) => e.action === 'server.agent.install' && e.result === 'ok')).toBe(true);
  });

  it('энроллмент: токен одноразовый, без CSRF, ключ пиннится', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/agent/v1/enroll')
      .send({ token, pubkey: pubkeyB64, version: '0.5.0-test', hostname: 'node-e2e' })
      .expect(200);
    const enrolled = agentEnrollResponseSchema.parse(res.body);
    expect(enrolled.serverId).toBe(serverId);
    expect(enrolled.serverName).toBe('agent-host');
    expect(enrolled.wsUrl).toContain('/api/agent/v1/ws');

    // повторно тот же токен — отказ без деталей
    await request(app.getHttpServer())
      .post('/api/agent/v1/enroll')
      .send({ token, pubkey: pubkeyB64, version: '0.5.0-test' })
      .expect(400);

    const server = serverSchema.parse((await agent.get(`/api/servers/${serverId}`).expect(200)).body);
    expect(server.agentStatus).toBe('pending');
  });

  it('чужая подпись отклоняется: error auth-failed и разрыв', async () => {
    const stranger = generateKeyPairSync('ed25519');
    const ws = new WsAgent();
    await ws.connect(wsBase);
    ws.send(AGENT_MSG.hello, { serverId, pubkey: pubkeyB64, version: '0.5.0-test' });
    const challenge = await ws.next();
    expect(challenge.type).toBe(AGENT_MSG.challenge);
    const nonce = (challenge.payload as { nonce: string }).nonce;
    const badSig = edSign(null, Buffer.from(nonce, 'base64'), stranger.privateKey).toString('base64');
    ws.send(AGENT_MSG.auth, { signature: badSig });
    const err = await ws.next();
    expect(err.type).toBe(AGENT_MSG.error);
    expect((err.payload as { code: string }).code).toBe('auth-failed');
  });

  it('полный цикл: hello → challenge → auth → welcome, heartbeat и метрики, offline при разрыве', async () => {
    const ws = new WsAgent();
    await ws.connect(wsBase);
    ws.send(AGENT_MSG.hello, { serverId, pubkey: pubkeyB64, version: '0.5.0-test' });
    const challenge = await ws.next();
    ws.send(AGENT_MSG.auth, { signature: signNonce((challenge.payload as { nonce: string }).nonce) });
    const welcome = await ws.next();
    expect(welcome.type).toBe(AGENT_MSG.welcome);
    expect(welcome.payload).toMatchObject({
      serverName: 'agent-host',
      heartbeatSeconds: 10,
      metricsSeconds: 10,
    });

    ws.send(AGENT_MSG.heartbeat, {});
    ws.send(AGENT_MSG.metrics, METRICS);
    // шлюз не отвечает на heartbeat/metrics — убеждаемся, что статус стал online
    await expect
      .poll(
        async () =>
          serverSchema.parse((await agent.get(`/api/servers/${serverId}`).expect(200)).body).agentStatus,
        { timeout: 5_000 },
      )
      .toBe('online');
    const online = serverSchema.parse((await agent.get(`/api/servers/${serverId}`).expect(200)).body);
    expect(online.agentVersion).toBe('0.5.0-test');
    expect(online.agentLastSeenAt).not.toBeNull();

    ws.ws.close();
    await expect
      .poll(
        async () =>
          serverSchema.parse((await agent.get(`/api/servers/${serverId}`).expect(200)).body).agentStatus,
        { timeout: 5_000 },
      )
      .toBe('offline');

    const audit = auditListResponseSchema.parse(
      (await agent.get('/api/audit?category=server').expect(200)).body,
    );
    for (const action of ['server.agent.enrolled', 'server.agent.online', 'server.agent.offline'])
      expect(audit.items.some((e) => e.action === action)).toBe(true);
  });

  it('настройки автопроверок управляют welcome: метрики выключены → metricsSeconds 0', async () => {
    await agent
      .put('/api/settings/autochecks')
      .set(CSRF_HEADER, csrf)
      .send({ metricsEnabled: false })
      .expect(200);
    const ws = new WsAgent();
    await ws.connect(wsBase);
    ws.send(AGENT_MSG.hello, { serverId, pubkey: pubkeyB64, version: '0.5.0-test' });
    const challenge = await ws.next();
    ws.send(AGENT_MSG.auth, { signature: signNonce((challenge.payload as { nonce: string }).nonce) });
    const welcome = await ws.next();
    expect((welcome.payload as { metricsSeconds: number }).metricsSeconds).toBe(0);
    ws.ws.close();
  });

  it('установка по SSH: панель выполняет скрипт из релизов, статус — «Ожидает агента»', async () => {
    // Предыдущий ws-тест закрыл соединение — дождёмся, пока агент честно станет «не в сети».
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const cur = serverSchema.parse((await agent.get(`/api/servers/${serverId}`).expect(200)).body);
      if (cur.agentStatus !== 'online') break;
      await new Promise((r) => setTimeout(r, 100));
    }
    const res = await agent.post(`/api/servers/${serverId}/agent/install`).set(CSRF_HEADER, csrf).expect(200);
    const updated = serverSchema.parse(res.body);
    expect(updated.agentStatus).toBe('pending');
    expect(ssh.execLog.some((c) => c.includes('install.sh') && c.includes('--token'))).toBe(true);
    expect(ssh.execLog.some((c) => c.includes('github.com/feauche/nodeservice-agent'))).toBe(true);
  });

  it('настройки: GET отдаёт дефолты после PUT-отката «По умолчанию»', async () => {
    const res = await agent
      .put('/api/settings/autochecks')
      .set(CSRF_HEADER, csrf)
      .send({ metricsEnabled: true, metricsIntervalSeconds: 10 })
      .expect(200);
    expect(res.body.metricsEnabled).toBe(true);
    const audit = auditListResponseSchema.parse(
      (await agent.get('/api/audit?category=settings').expect(200)).body,
    );
    expect(audit.items.some((e) => e.action === 'settings.autochecks.updated')).toBe(true);
  });
});
