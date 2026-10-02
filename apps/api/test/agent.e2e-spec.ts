import { sign as edSign, generateKeyPairSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import {
  AGENT_MSG,
  AGENT_PROTOCOL_VERSION,
  type AgentEnvelope,
  AUTOCHECKS_DEFAULTS,
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
import { AgentGateway, CLOSE_SERVER_DELETED } from '../src/modules/agent/agent.gateway.js';
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

  async connect(url: string, headers: Record<string, string> = {}): Promise<void> {
    this.ws = new WebSocket(url, { headers });
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

  it('полный цикл: hello → challenge → auth → welcome, heartbeat и метрики', async () => {
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
    // Короткий разрыв не красит весь парк: offline ставит джоба по таймауту сигналов.
    await new Promise((r) => setTimeout(r, 100));
    expect(await statusOf(serverId)).toBe('online');

    const audit = auditListResponseSchema.parse(
      (await agent.get('/api/audit?category=server').expect(200)).body,
    );
    for (const action of ['server.agent.enrolled', 'server.agent.online'])
      expect(audit.items.some((e) => e.action === action)).toBe(true);
  });

  /** Вошедший агент: hello → challenge → auth → welcome. headers — например, адрес «клиента» за Caddy. */
  const login = async (
    id: string,
    pub: string,
    sign: (nonce: string) => string,
    headers: Record<string, string> = {},
  ): Promise<WsAgent> => {
    const ws = new WsAgent();
    await ws.connect(wsBase, headers);
    ws.send(AGENT_MSG.hello, { serverId: id, pubkey: pub, version: '0.5.0-test' });
    const challenge = await ws.next();
    ws.send(AGENT_MSG.auth, { signature: sign((challenge.payload as { nonce: string }).nonce) });
    expect((await ws.next()).type).toBe(AGENT_MSG.welcome);
    return ws;
  };
  const statusOf = async (id: string) =>
    serverSchema.parse((await agent.get(`/api/servers/${id}`).expect(200)).body).agentStatus;
  /** Записи Журнала о сервере, новые сверху. */
  const journal = async (targetId: string) =>
    auditListResponseSchema.parse(
      (await agent.get(`/api/audit?category=server&targetId=${targetId}&pageSize=200`).expect(200)).body,
    ).items;

  it('сигнал по открытому соединению возвращает «в сети»: статус не залипает, в Журнале одна запись', async () => {
    const ws = await login(serverId, pubkeyB64, signNonce);
    await expect.poll(() => statusOf(serverId), { timeout: 5_000 }).toBe('online');
    const before = (await journal(serverId)).filter((e) => e.action === 'server.agent.online').length;
    // Сигналов не было дольше порога — джоба пометила «не в сети»; соединение при этом не рвалось.
    await app.get<Db>(DB).execute(sql`update servers set agent_status = 'offline' where id = ${serverId}`);
    ws.send(AGENT_MSG.heartbeat, {});
    ws.send(AGENT_MSG.metrics, METRICS);
    await expect.poll(() => statusOf(serverId), { timeout: 5_000 }).toBe('online');
    ws.send(AGENT_MSG.heartbeat, {});
    ws.send(AGENT_MSG.heartbeat, {});
    await new Promise((r) => setTimeout(r, 300));
    const online = (await journal(serverId)).filter((e) => e.action === 'server.agent.online');
    expect(online).toHaveLength(before + 1);
    expect(String(online[0]?.metadata.reason)).toMatch(/возобновились/);

    ws.ws.close();
    await new Promise((r) => setTimeout(r, 100));
    expect(await statusOf(serverId)).toBe('online');
  });

  it('отвергнутый агент стучится снова и снова — в Журнале одна запись в час, с числом попыток', async () => {
    const ghost = crypto.randomUUID();
    const knock = async () => {
      const ws = new WsAgent();
      await ws.connect(wsBase);
      ws.send(AGENT_MSG.hello, { serverId: ghost, pubkey: pubkeyB64, version: '0.5.0-test' });
      expect(((await ws.next()).payload as { code: string }).code).toBe('unknown-server');
    };
    const denied = async () => (await journal(ghost)).filter((e) => e.action === 'server.agent.auth_failed');
    for (let i = 0; i < 3; i += 1) await knock();
    expect(await denied()).toHaveLength(1);
    expect((await denied())[0]?.metadata).toMatchObject({ code: 'unknown-server', attempts: 1 });

    // Час спустя — следующая запись; в ней видно, сколько попыток панель отклонила за это время.
    const marks = (app.get(AgentGateway) as unknown as { authFailures: Map<string, { loggedAt: number }> })
      .authFailures;
    (marks.get(ghost) as { loggedAt: number }).loggedAt -= 61 * 60_000;
    await knock();
    await knock();
    expect(await denied()).toHaveLength(2);
    expect((await denied())[0]?.metadata).toMatchObject({ attempts: 3 });
  });

  it('без входа с одного адреса — не больше пяти соединений: шестое закрывается сразу; другой адрес и вошедшие агенты не в счёт', async () => {
    // Адрес клиента панель берёт из X-Forwarded-For от Caddy (TRUST_PROXY=1), как у HTTP-запросов.
    const from = (ip: string) => ({ 'x-forwarded-for': ip });
    const opened: WebSocket[] = [];
    /** Соединение открылось и молчит: вход не начат. */
    const silent = (ip: string) =>
      new Promise<WebSocket>((resolve, reject) => {
        const ws = new WebSocket(wsBase, { headers: from(ip) });
        ws.once('open', () => {
          opened.push(ws);
          resolve(ws);
        });
        ws.once('error', reject);
      });
    /** Отказ до рукопожатия: текст ошибки клиента (в нём код ответа). */
    const refused = (ip: string) =>
      new Promise<string>((resolve, reject) => {
        const ws = new WebSocket(wsBase, { headers: from(ip) });
        ws.once('open', () => {
          ws.terminate();
          reject(new Error('соединение открылось'));
        });
        ws.once('error', (err) => resolve(err.message));
      });
    const A = '198.51.100.20';
    try {
      // Агент с того же адреса вошёл — его соединение в счёт не идёт.
      const confirmed = await login(serverId, pubkeyB64, signNonce, from(A));
      for (let i = 0; i < 5; i += 1) await silent(A);
      expect(await refused(A)).toContain('429');
      expect(await refused(A)).toContain('429');
      await silent('198.51.100.21');
      // Закрыли одно молчащее — место освободилось.
      opened[0]?.close();
      await expect
        .poll(
          () =>
            silent(A).then(
              () => true,
              () => false,
            ),
          { timeout: 5_000 },
        )
        .toBe(true);
      // Вошедший агент работает как прежде.
      confirmed.send(AGENT_MSG.heartbeat, {});
      await new Promise((r) => setTimeout(r, 200));
      expect(confirmed.closed).toBe(false);
      confirmed.ws.close();
    } finally {
      for (const ws of opened) ws.terminate();
    }
  });

  it('до входа — одно короткое сообщение на шаг: не то по шагу закрывает соединение', async () => {
    const ws = new WsAgent();
    await ws.connect(wsBase);
    const closed = new Promise<number>((resolve) => ws.ws.once('close', (code) => resolve(code)));
    ws.send(AGENT_MSG.heartbeat, {});
    const err = await ws.next();
    expect(err.type).toBe(AGENT_MSG.error);
    expect((err.payload as { code: string }).code).toBe('protocol');
    expect(await closed).toBe(4400);
  });

  it('прихожая занята с десяти адресов — агент сервера парка всё равно входит, чужой адрес получает 429', async () => {
    const from = (ip: string) => ({ 'x-forwarded-for': ip });
    const opened: WebSocket[] = [];
    /** Соединение открылось и молчит: вход не начат. */
    const silent = (ip: string) =>
      new Promise<void>((resolve, reject) => {
        const ws = new WebSocket(wsBase, { headers: from(ip) });
        opened.push(ws);
        ws.on('error', () => {});
        ws.once('open', () => resolve());
        ws.once('unexpected-response', (_req, res) => {
          ws.terminate();
          reject(new Error(`HTTP ${res.statusCode}`));
        });
      });
    try {
      for (let a = 1; a <= 10; a += 1) for (let i = 0; i < 5; i += 1) await silent(`198.51.100.${100 + a}`);
      await expect(silent('198.51.100.120')).rejects.toThrow('HTTP 429');
      // «agent-host» заведён с адресом 127.0.0.1 — его агент входит и при занятой прихожей.
      const confirmed = await login(serverId, pubkeyB64, signNonce, from('127.0.0.1'));
      confirmed.send(AGENT_MSG.heartbeat, {});
      await new Promise((r) => setTimeout(r, 200));
      expect(confirmed.closed).toBe(false);
      confirmed.ws.close();
    } finally {
      for (const ws of opened) ws.terminate();
    }
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
    // Установка сама снимает старую зелёную отметку и ждёт сигнала от нового агента.
    const res = await agent.post(`/api/servers/${serverId}/agent/install`).set(CSRF_HEADER, csrf).expect(200);
    const updated = serverSchema.parse(res.body);
    expect(updated.agentStatus).toBe('pending');
    expect(
      ssh.execLog.some(
        (c) => c.includes('install.sh') && c.includes('--listen-port') && c.includes('--access-key-stdin'),
      ),
    ).toBe(true);
    expect(ssh.execLog.some((c) => /nsa_[A-Za-z0-9_-]+/.test(c))).toBe(false);
    expect(ssh.execLog.some((c) => c.includes('github.com/feauche/nodeservice-agent'))).toBe(true);
  });

  it('установка не удалась: причина словами, ни команды, ни ключа в ответе и в Журнале', async () => {
    const before = await statusOf(serverId);
    const reason =
      'Установочный скрипт агента не скачался: скачивание с GitHub не уложилось в минуту. На сервере ничего не изменено.';
    ssh.agentInstall = { code: 1, output: `${reason}\n` };
    try {
      const res = await agent
        .post(`/api/servers/${serverId}/agent/install`)
        .set(CSRF_HEADER, csrf)
        .expect(502);
      expect(res.body.detail).toBe(`Команда на сервере не выполнилась (установка агента): ${reason}`);
      const command = [...ssh.execLog].reverse().find((c) => c.includes('# ns-agent:install')) ?? '';
      expect(command).toContain('--access-key-stdin');
      expect(command).not.toMatch(/nsa_[A-Za-z0-9_-]+/);
      const log = await journal(serverId);
      expect(log.find((e) => e.action === 'server.agent.install')).toMatchObject({
        result: 'failed',
        metadata: { reason: res.body.detail },
      });
      for (const secret of ['nsa_', 'curl', 'mktemp'])
        expect(JSON.stringify([res.body, log]), secret).not.toContain(secret);
      // Статус — прежний, а не «Ожидает агента».
      expect(await statusOf(serverId)).toBe(before);
    } finally {
      ssh.agentInstall = { code: 0, output: '' };
    }
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

  it('порог «Агент не в сети» меньше трёх сигналов не принимается; сохранённый раньше меньший порог миграция поднимает до минимума', async () => {
    const low = await agent
      .put('/api/settings/autochecks')
      .set(CSRF_HEADER, csrf)
      .send({ agentOfflineAfterSeconds: 10 })
      .expect(400);
    expect(JSON.stringify(low.body.errors)).toContain('Не меньше 30');
    const ok = await agent
      .put('/api/settings/autochecks')
      .set(CSRF_HEADER, csrf)
      .send({ agentOfflineAfterSeconds: 30 })
      .expect(200);
    expect(ok.body.agentOfflineAfterSeconds).toBe(30);

    const db = app.get<Db>(DB);
    // Хранилище настроек держит прочитанное 5 секунд — для проверки «как после перезапуска» сбрасываем.
    const { AutochecksStore } = await import('../src/modules/settings/autochecks.store.js');
    const store = app.get(AutochecksStore) as unknown as { cache: unknown };
    const save = (value: string) =>
      db.execute(
        sql`insert into app_meta (key, value) values ('settings.autochecks', ${value})
            on conflict (key) do update set value = excluded.value`,
      );
    const stored = async () =>
      (await db.execute<{ value: string }>(sql`select value from app_meta where key = 'settings.autochecks'`))
        .rows[0]?.value ?? '';
    const current = async () => {
      store.cache = null;
      return (await agent.get('/api/settings/autochecks').expect(200)).body as typeof AUTOCHECKS_DEFAULTS;
    };
    const migration = readFileSync(
      new URL('../drizzle/migrations/0048_autochecks_agent_offline_min.sql', import.meta.url),
      'utf8',
    );
    try {
      // Настройки прежней версии: порог 15 секунд и свой интервал проверки SSH.
      const old = { ...AUTOCHECKS_DEFAULTS, sshIntervalMinutes: 45, agentOfflineAfterSeconds: 15 };
      await save(JSON.stringify(old));
      // Без миграции запись не проходит проверку — и весь раздел возвращается к значениям по умолчанию.
      expect((await current()).sshIntervalMinutes).toBe(AUTOCHECKS_DEFAULTS.sshIntervalMinutes);
      await db.execute(sql.raw(migration));
      expect(JSON.parse(await stored())).toEqual({ ...old, agentOfflineAfterSeconds: 30 });
      expect(await current()).toMatchObject({ sshIntervalMinutes: 45, agentOfflineAfterSeconds: 30 });
      // Повторный запуск и значения, которые менять не нужно, — без изменений.
      for (const keep of [30, 120, 600]) {
        const value = JSON.stringify({ ...old, agentOfflineAfterSeconds: keep });
        await save(value);
        await db.execute(sql.raw(migration));
        expect(await stored(), String(keep)).toBe(value);
      }
      // Повреждённая запись миграцию не роняет.
      await save('не json');
      await db.execute(sql.raw(migration));
      expect(await stored()).toBe('не json');
    } finally {
      await save(JSON.stringify(AUTOCHECKS_DEFAULTS));
      store.cache = null;
    }
  });

  it('удаление сервера закрывает соединение его агента особым кодом, без «пропал со связи» в Журнале', async () => {
    const db = app.get<Db>(DB);
    const created = await agent
      .post('/api/servers')
      .set(CSRF_HEADER, csrf)
      .send({
        name: 'agent-gone',
        host: '127.0.0.1',
        port: ssh.port,
        sshUser: SSH_USER,
        auth: { method: 'password', password: SSH_PASSWORD },
      })
      .expect(201);
    const goneId = serverSchema.parse(created.body).id;
    // Фоновая автоустановка выпускает свой токен — дождёмся её, чтобы не гоняться за токенами.
    await expect.poll(() => statusOf(goneId), { timeout: 10_000 }).toBe('pending');
    const issued = await agent
      .post(`/api/servers/${goneId}/enrollment-token`)
      .set(CSRF_HEADER, csrf)
      .expect(200);
    const k = generateKeyPairSync('ed25519');
    const pub = (k.publicKey.export({ format: 'der', type: 'spki' }) as Buffer)
      .subarray(-32)
      .toString('base64');
    await request(app.getHttpServer())
      .post('/api/agent/v1/enroll')
      .send({ token: issued.body.token as string, pubkey: pub, version: '0.5.0-test' })
      .expect(200);
    const ws = await login(goneId, pub, (nonce) =>
      edSign(null, Buffer.from(nonce, 'base64'), k.privateKey).toString('base64'),
    );
    await expect.poll(() => statusOf(goneId), { timeout: 5_000 }).toBe('online');

    const closed = new Promise<number>((resolve) => ws.ws.once('close', (code) => resolve(code)));
    await agent.delete(`/api/servers/${goneId}`).set(CSRF_HEADER, csrf).expect(204);
    const bye = await ws.next();
    expect(bye.type).toBe(AGENT_MSG.error);
    expect(bye.payload).toMatchObject({ code: 'unknown-server', message: 'Сервер удалён из панели' });
    expect(await closed).toBe(CLOSE_SERVER_DELETED);
    await new Promise((r) => setTimeout(r, 200));
    const after = await db.execute<{ action: string }>(
      sql`select action from audit_log where target_id = ${goneId} and action = 'server.agent.offline'`,
    );
    expect(after.rows).toEqual([]);
  }, 30_000);

  it('запись сервера исчезла мимо панели (восстановление из копии): первый же сигнал агента закрывает соединение', async () => {
    const ws = await login(serverId, pubkeyB64, signNonce);
    await expect.poll(() => statusOf(serverId), { timeout: 5_000 }).toBe('online');
    const closed = new Promise<number>((resolve) => ws.ws.once('close', (code) => resolve(code)));
    // Удаляем строку напрямую: слушатели удаления не сработали, соединение осталось открытым.
    await app.get<Db>(DB).execute(sql`delete from servers where id = ${serverId}`);
    ws.send(AGENT_MSG.heartbeat, {});
    const bye = await ws.next();
    expect(bye.payload).toMatchObject({ code: 'unknown-server', message: 'Сервер удалён из панели' });
    expect(await closed).toBe(CLOSE_SERVER_DELETED);
  });
});
