import type { Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import {
  CSRF_HEADER,
  serverSchema,
  type TerminalServerMsg,
  terminalOpenResponseSchema,
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
import { SessionStore } from '../src/modules/auth/session.store.js';
import { SetupService } from '../src/modules/auth/setup.service.js';
import { UsersRepository } from '../src/modules/auth/users.repository.js';
import { TerminalGateway } from '../src/modules/terminal/terminal.gateway.js';
import { FakeSsh, SSH_PASSWORD, SSH_USER } from './fake-ssh.js';

if (!process.env.DATABASE_URL?.endsWith('/nodeservice_test'))
  throw new Error('e2e: DATABASE_URL должен указывать на nodeservice_test');

const LOGIN = 'admin';
const PASSWORD = 'correct horse battery staple';

/** Сбор входящих сообщений терминала. */
class TermClient {
  ws!: WebSocket;
  private queue: TerminalServerMsg[] = [];
  private waiters: Array<(m: TerminalServerMsg) => void> = [];
  closeCode = 0;

  connect(url: string, cookie: string): Promise<void> {
    this.ws = new WebSocket(url, { headers: { cookie } });
    this.ws.on('message', (raw) => {
      const m = JSON.parse(String(raw)) as TerminalServerMsg;
      const w = this.waiters.shift();
      if (w) w(m);
      else this.queue.push(m);
    });
    this.ws.on('close', (code) => {
      this.closeCode = code;
    });
    return new Promise((resolve, reject) => {
      this.ws.once('open', resolve);
      this.ws.once('error', reject);
    });
  }
  send(obj: unknown): void {
    this.ws.send(JSON.stringify(obj));
  }
  next(timeoutMs = 5000): Promise<TerminalServerMsg> {
    const m = this.queue.shift();
    if (m) return Promise.resolve(m);
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('нет сообщения терминала')), timeoutMs);
      this.waiters.push((mm) => {
        clearTimeout(t);
        resolve(mm);
      });
    });
  }
  async until(pred: (m: TerminalServerMsg) => boolean): Promise<TerminalServerMsg> {
    for (;;) {
      const m = await this.next();
      if (pred(m)) return m;
    }
  }
}

describe('terminal e2e', () => {
  let app: INestApplication;
  let agent: InstanceType<typeof TestAgent>;
  let csrf: string;
  let userId: string;
  let wsBase = '';
  let cookie = '';
  const ssh = new FakeSsh();
  let serverId = '';

  const cookieFrom = (res: request.Response, prev = ''): string => {
    const set = res.headers['set-cookie'];
    const jar = new Map<string, string>();
    for (const pair of prev.split('; ').filter(Boolean)) {
      const eq = pair.indexOf('=');
      if (eq > 0) jar.set(pair.slice(0, eq), pair.slice(eq + 1));
    }
    for (const c of Array.isArray(set) ? set : []) {
      const first = c.split(';')[0];
      const eq = first.indexOf('=');
      if (eq > 0 && first.slice(eq + 1)) jar.set(first.slice(0, eq), first.slice(eq + 1));
    }
    return [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
  };

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
    app.get(TerminalGateway).register();
    app.get(WsUpgradeService).attach(app.getHttpServer() as HttpServer);
    const port = (app.getHttpServer().address() as AddressInfo).port;
    wsBase = `ws://127.0.0.1:${port}`;

    agent = request.agent(app.getHttpServer());
    csrf = (await agent.get('/api/auth/csrf').expect(200)).body.token as string;
    const setupToken = await app.get(SetupService).issueToken();
    const start = await agent
      .post('/api/auth/setup/start')
      .set(CSRF_HEADER, csrf)
      .send({ setupToken, login: LOGIN, password: PASSWORD })
      .expect(200);
    const confirm = await agent
      .post('/api/auth/setup/confirm')
      .set(CSRF_HEADER, csrf)
      .send({ code: await generate({ secret: start.body.totpSecret as string }) })
      .expect(200);
    userId = (await app.get(UsersRepository).findByLogin(LOGIN))?.id ?? '';
    cookie = cookieFrom(confirm);

    const created = await agent
      .post('/api/servers')
      .set(CSRF_HEADER, csrf)
      .send({
        name: 'term-host',
        host: '127.0.0.1',
        port: ssh.port,
        sshUser: SSH_USER,
        auth: { method: 'password', password: SSH_PASSWORD },
      })
      .expect(201);
    serverId = serverSchema.parse(created.body).id;
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await ssh.stop();
  });

  it('preflight: терминал открывается сразу, без подтверждения пароля (step-up снят)', async () => {
    const sessions = app.get(SessionStore);
    const [session] = await sessions.listForUser(userId);
    if (!session) throw new Error('нет сессии');
    // Даже с устаревшим step-up терминал открывается — подтверждение пароля больше не требуется.
    await sessions.setStepUp(session.id, new Date(Date.now() - 10 * 60_000));
    const ok = await agent.post(`/api/servers/${serverId}/terminal`).set(CSRF_HEADER, csrf).expect(200);
    const parsed = terminalOpenResponseSchema.parse(ok.body);
    expect(parsed.url).toContain('/ws/terminal?server=');
  });

  it('WebSocket: приветствие PTY, эхо ввода, закрытие → Журнал terminal.open/close', async () => {
    const term = new TermClient();
    await term.connect(`${wsBase}/ws/terminal?server=${serverId}&cols=100&rows=30`, cookie);
    const ready = await term.until((m) => m.t === 'y' || m.t === 'e');
    expect(ready.t).toBe('y');
    // приглашение фейкового shell (учитывает переданные cols)
    const greeting = await term.until((m) => m.t === 'o');
    expect(greeting.t === 'o' && greeting.d.includes('100 cols')).toBe(true);
    // эхо ввода
    term.send({ t: 'i', d: 'whoami\n' });
    const echo = await term.until((m) => m.t === 'o' && m.d.includes('whoami'));
    expect(echo.t).toBe('o');
    term.ws.close();
    await new Promise((r) => setTimeout(r, 300));

    const audit = (await agent.get('/api/audit?category=server').expect(200)).body as {
      items: Array<{ action: string }>;
    };
    expect(audit.items.some((e) => e.action === 'server.terminal.open')).toBe(true);
    expect(audit.items.some((e) => e.action === 'server.terminal.close')).toBe(true);

    // История терминала: сессия записана вместе с выводом (эхо whoami), завершена, без ввода как такового.
    await new Promise((r) => setTimeout(r, 1800));
    const list = (await agent.get(`/api/servers/${serverId}/terminal/sessions`).expect(200)).body as {
      items: Array<{ id: string; endedAt: string | null; bytesOut: number; cols: number }>;
    };
    expect(list.items.length).toBeGreaterThanOrEqual(1);
    const last = list.items[0]!;
    expect(last.cols).toBe(100);
    expect(last.endedAt).not.toBeNull();
    expect(last.bytesOut).toBeGreaterThan(0);
    const detail = (await agent.get(`/api/servers/${serverId}/terminal/sessions/${last.id}`).expect(200))
      .body as { transcript: string };
    expect(detail.transcript).toContain('100 cols');
    expect(detail.transcript).toContain('whoami');
    // догрузка по смещению: хвост записи и полная длина
    const full = detail.transcript.length;
    const tail = (
      await agent.get(`/api/servers/${serverId}/terminal/sessions/${last.id}?offset=${full - 5}`).expect(200)
    ).body as { transcript: string; offset: number; length: number };
    expect(tail).toMatchObject({ offset: full - 5, length: full });
    expect(tail.transcript).toBe(detail.transcript.slice(full - 5));

    // Поиск по записям: без регистра, по тексту без ANSI-кодов, с числом совпадений; чужое — пусто.
    const found = (await agent.get(`/api/servers/${serverId}/terminal/sessions?q=WHOAMI`).expect(200))
      .body as {
      items: Array<{ id: string; matches: number }>;
    };
    expect(found.items.map((s) => s.id)).toContain(last.id);
    const hit = found.items.find((s) => s.id === last.id)!;
    expect(hit.matches).toBeGreaterThanOrEqual(1);
    // biome-ignore lint/suspicious/noControlCharactersInRegex: это ANSI-последовательности
    const plain = detail.transcript.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '').toLowerCase();
    expect(hit.matches).toBe(plain.split('whoami').length - 1);
    const none = (
      await agent.get(`/api/servers/${serverId}/terminal/sessions?q=нет-такой-строки-точно`).expect(200)
    ).body as { items: unknown[] };
    expect(none.items).toHaveLength(0);
    // период: сессии будущего не бывает
    const future = new Date(Date.now() + 3_600_000).toISOString();
    const later = (await agent.get(`/api/servers/${serverId}/terminal/sessions?since=${future}`).expect(200))
      .body as { items: unknown[] };
    expect(later.items).toHaveLength(0);
    await agent.get(`/api/servers/${serverId}/terminal/sessions?since=abc`).expect(400);
    await agent.get(`/api/servers/${serverId}/terminal/sessions?q=${'x'.repeat(201)}`).expect(400);
  }, 20_000);

  it('WebSocket без cookie — закрывается кодом 4401', async () => {
    const term = new TermClient();
    await term.connect(`${wsBase}/ws/terminal?server=${serverId}`, 'x=y');
    await term.until((m) => m.t === 'e');
    await new Promise((r) => setTimeout(r, 200));
    expect(term.closeCode).toBe(4401);
  });
});
