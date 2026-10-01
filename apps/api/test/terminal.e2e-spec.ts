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
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';

import { AppModule } from '../src/app.module.js';
import { CookiesService } from '../src/common/http/cookies.service.js';
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
import { TerminalSessionsRepository } from '../src/modules/terminal/terminal-sessions.repository.js';
import { FakeSsh, SSH_PASSWORD, SSH_USER } from './fake-ssh.js';

if (!process.env.DATABASE_URL?.endsWith('/nodeservice_test'))
  throw new Error('e2e: DATABASE_URL должен указывать на nodeservice_test');

const LOGIN = 'admin';
const PASSWORD = 'correct horse battery staple';

/** Сбор входящих сообщений терминала. */
class TermClient {
  /** Все открытые в файле сокеты: упавший тест не должен держать сервер открытым до таймаута afterAll. */
  static all: TermClient[] = [];
  ws!: WebSocket;
  private queue: TerminalServerMsg[] = [];
  private waiters: Array<(m: TerminalServerMsg) => void> = [];
  closeCode = 0;

  connect(url: string, cookie: string, headers: Record<string, string> = {}): Promise<void> {
    this.ws = new WebSocket(url, { headers: { cookie, ...headers } });
    TermClient.all.push(this);
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
  /** Коды восстановления — чтобы войти заново после теста с выходом (код из приложения в ту же полминуты повторно не принимается). */
  let recoveryCodes: string[] = [];
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
    recoveryCodes = confirm.body.recoveryCodes as string[];
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
    for (const c of TermClient.all) c.ws.terminate();
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
    const last = list.items[0];
    if (!last) throw new Error('История терминала пуста после завершённой сессии');
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
    const hit = found.items.find((s) => s.id === last.id);
    if (!hit) throw new Error('Завершённая сессия не найдена поиском по истории');
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

  it('история: смещение и длина — в символах записи, догрузка по прошлому length с эмодзи ничего не теряет', async () => {
    const repo = app.get(TerminalSessionsRepository);
    const id = await repo.start({ serverId, actorId: userId, actorDisplay: LOGIN, cols: 80, rows: 24 });
    await repo.append(id, 'Готово 🎉\r\n', 16);
    const url = `/api/servers/${serverId}/terminal/sessions/${id}`;
    type Detail = { transcript: string; offset: number; length: number };

    const first = (await agent.get(url).expect(200)).body as Detail;
    expect(first.transcript).toBe('Готово 🎉\r\n');
    // Эмодзи — один символ записи, хотя в строке JavaScript его длина 2: длины расходятся.
    expect(first.length).toBe(10);
    expect(first.transcript.length).toBe(11);

    // Нового вывода нет: по прошлому length — пустой хвост и та же длина (запись не «сжимается»).
    const same = (await agent.get(`${url}?offset=${first.length}`).expect(200)).body as Detail;
    expect(same).toMatchObject({ transcript: '', offset: 10, length: 10 });

    // Новый вывод: по прошлому length хвост приходит целиком и склеивается в полную запись.
    await repo.append(id, 'apt 🚀 ok', 12);
    const tail = (await agent.get(`${url}?offset=${first.length}`).expect(200)).body as Detail;
    expect(tail).toMatchObject({ transcript: 'apt 🚀 ok', offset: 10, length: 18 });
    expect(first.transcript + tail.transcript).toBe('Готово 🎉\r\napt 🚀 ok');
    const whole = (await agent.get(url).expect(200)).body as Detail;
    expect(whole.transcript).toBe(first.transcript + tail.transcript);

    // Смещение по длине строки JavaScript (так считал клиент) съедало первый символ хвоста.
    const skewed = (await agent.get(`${url}?offset=${first.transcript.length}`).expect(200)).body as Detail;
    expect(skewed.transcript).toBe('pt 🚀 ok');
  });

  it('срок сессии продлевают запросы к панели, а не ввод и вывод терминала (как и сказано в «Политике»)', async () => {
    const [session] = await app.get(SessionStore).listForUser(userId);
    if (!session) throw new Error('нет сессии');
    const valkey = app.get<Redis>(VALKEY);
    const key = `sess:${session.id}`;
    const term = new TermClient();
    await term.connect(`${wsBase}/ws/terminal?server=${serverId}`, cookie);
    expect((await term.until((m) => m.t === 'y' || m.t === 'e')).t).toBe('y');
    await agent.get('/api/auth/status').expect(200);
    const before = await valkey.pttl(key);

    for (let i = 0; i < 6; i += 1) {
      term.send({ t: 'i', d: `echo tick-${i}\n` });
      await term.until((m) => m.t === 'o' && m.d.includes(`tick-${i}`));
      await new Promise((r) => setTimeout(r, 200));
    }
    const afterTerminal = await valkey.pttl(key);
    expect(afterTerminal).toBeLessThan(before - 1000);
    // Опрос статуса, которым открытая панель обращается к серверу раз в минуту, срок продлевает.
    await agent.get('/api/auth/status').expect(200);
    expect(await valkey.pttl(key)).toBeGreaterThan(afterTerminal + 1000);
    term.ws.close();
    await new Promise((r) => setTimeout(r, 300));
  }, 20_000);

  it('экран заблокирован: ввод в открытый терминал до сервера не доходит, новый не открыть; после пароля тот же терминал снова принимает ввод', async () => {
    const term = new TermClient();
    await term.connect(`${wsBase}/ws/terminal?server=${serverId}`, cookie);
    expect((await term.until((m) => m.t === 'y' || m.t === 'e')).t).toBe('y');
    await term.until((m) => m.t === 'o'); // приглашение оболочки

    await agent.post('/api/auth/lock').set(CSRF_HEADER, csrf).expect(204);
    await agent.get('/api/servers').expect(403);
    const fresh = new TermClient();
    await fresh.connect(`${wsBase}/ws/terminal?server=${serverId}`, cookie);
    await fresh.until((m) => m.t === 'e');
    await new Promise((r) => setTimeout(r, 200));
    expect(fresh.closeCode).toBe(4403);

    // Окно спрятано под экраном блокировки, но сокет жив: добравшийся до него без пароля ничего не введёт.
    term.send({ t: 'i', d: 'echo typed-while-locked\n' });
    await new Promise((r) => setTimeout(r, 500));

    await agent.post('/api/auth/unlock').set(CSRF_HEADER, csrf).send({ password: PASSWORD }).expect(200);
    term.send({ t: 'i', d: 'echo after-unlock\n' });
    const seen: string[] = [];
    await term.until((m) => {
      if (m.t === 'o') seen.push(m.d);
      return m.t === 'o' && m.d.includes('after-unlock');
    });
    // Отброшенный ввод не копился и не «доехал» до оболочки после пароля; терминал всё это время жил.
    expect(seen.join('')).not.toContain('typed-while-locked');
    expect(term.closeCode).toBe(0);
    term.ws.close();
    await new Promise((r) => setTimeout(r, 300));
  }, 20_000);

  it('WebSocket без cookie — закрывается кодом 4401', async () => {
    const term = new TermClient();
    await term.connect(`${wsBase}/ws/terminal?server=${serverId}`, 'x=y');
    await term.until((m) => m.t === 'e');
    await new Promise((r) => setTimeout(r, 200));
    expect(term.closeCode).toBe(4401);
  });

  // Последний в файле: выходит из учётной записи.
  it('сессия панели кончилась (выход): открытый терминал закрывается при первом же вводе, в истории — причина', async () => {
    const term = new TermClient();
    await term.connect(`${wsBase}/ws/terminal?server=${serverId}`, cookie);
    expect((await term.until((m) => m.t === 'y' || m.t === 'e')).t).toBe('y');
    await term.until((m) => m.t === 'o');

    await agent.post('/api/auth/logout').set(CSRF_HEADER, csrf).expect(204);
    term.send({ t: 'i', d: 'echo after-logout\n' });
    await vi.waitFor(() => expect(term.closeCode).toBe(4401), { timeout: 5000 });

    const repo = app.get(TerminalSessionsRepository);
    const last = await vi.waitFor(
      async () => {
        const [s] = await repo.list(serverId, 1);
        expect(s?.endReason).toBe('сессия панели завершена');
        return s;
      },
      { timeout: 5000 },
    );
    // Команда до оболочки не дошла: оболочка повторяет ввод, и его нет в записи.
    const detail = await repo.get(serverId, last?.id ?? '');
    expect(detail?.transcript).not.toContain('after-logout');

    // Входим заново: следующие тесты ждут живую сессию с той же cookie.
    csrf = (await agent.get('/api/auth/csrf').expect(200)).body.token as string;
    await agent
      .post('/api/auth/login')
      .set(CSRF_HEADER, csrf)
      .send({ login: LOGIN, password: PASSWORD })
      .expect(200);
    const back = await agent
      .post('/api/auth/login/recovery')
      .set(CSRF_HEADER, csrf)
      .send({ code: recoveryCodes.pop() })
      .expect(200);
    cookie = cookieFrom(back, cookie);
  }, 20_000);
  it('без входа с одного адреса — не больше пяти соединений: шестое закрывается сразу; другой адрес и вошедшие не в счёт', async () => {
    const url = `${wsBase}/ws/terminal?server=${serverId}`;
    const from = (ip: string) => ({ 'x-forwarded-for': ip });
    const A = '198.51.100.30';
    const sessions = app.get(SessionStore);
    const original = sessions.get.bind(sessions);
    const stranger = `${app.get(CookiesService).names.session}=${'0'.repeat(43)}`;
    const opened: WebSocket[] = [];
    const silent = (ip: string) =>
      new Promise<void>((resolve, reject) => {
        const ws = new WebSocket(url, { headers: { cookie: stranger, ...from(ip) } });
        opened.push(ws);
        ws.on('error', () => {});
        ws.once('open', () => resolve());
        ws.once('unexpected-response', (_req, res) => {
          ws.terminate();
          reject(new Error(`HTTP ${res.statusCode}`));
        });
      });
    // Вошедший терминал с того же адреса в счёт не идёт.
    const confirmed = new TermClient();
    let letGo = () => {};
    try {
      await confirmed.connect(url, cookie, from(A));
      expect((await confirmed.until((m) => m.t === 'y' || m.t === 'e')).t).toBe('y');

      // Проверка сессии «подвисает» — соединения с чужой cookie остаются неподтверждёнными.
      const hold = new Promise<void>((resolve) => {
        letGo = resolve;
      });
      sessions.get = async (sid: string) => {
        await hold;
        return original(sid);
      };
      for (let i = 0; i < 5; i += 1) await silent(A);
      await expect(silent(A)).rejects.toThrow('HTTP 429');
      await silent('198.51.100.31');

      // Проверка отпущена: чужие соединения получают отказ входа и закрываются — места снова свободны.
      sessions.get = original;
      letGo();
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
    } finally {
      sessions.get = original;
      letGo();
      for (const ws of opened) ws.terminate();
      confirmed.ws?.terminate();
    }
  });

  it('прихожая занята с десяти адресов — владелец с действующей сессией всё равно открывает терминал', async () => {
    const url = `${wsBase}/ws/terminal?server=${serverId}`;
    const from = (ip: string) => ({ 'x-forwarded-for': ip });
    const sessions = app.get(SessionStore);
    const original = sessions.get.bind(sessions);
    const strangerSid = '1'.repeat(43);
    const stranger = `${app.get(CookiesService).names.session}=${strangerSid}`;
    const opened: WebSocket[] = [];
    /** Соединение открылось, вход ещё проверяется. */
    const pending = (ip: string, cookieHeader: string) =>
      new Promise<void>((resolve, reject) => {
        const ws = new WebSocket(url, { headers: { cookie: cookieHeader, ...from(ip) } });
        opened.push(ws);
        ws.on('error', () => {});
        ws.once('open', () => resolve());
        ws.once('unexpected-response', (_req, res) => {
          ws.terminate();
          reject(new Error(`HTTP ${res.statusCode}`));
        });
      });
    const owner = new TermClient();
    try {
      // Проверка чужой сессии «подвисает» — эти соединения держат все 50 мест прихожей. Она так и не ответит:
      // иначе 50 отказов съели бы общий предел записей Журнала без входа, на который опирается тест ниже.
      sessions.get = async (sid: string) =>
        sid === strangerSid ? new Promise<never>(() => {}) : original(sid);
      for (let a = 1; a <= 10; a += 1)
        for (let i = 0; i < 5; i += 1) await pending(`198.51.100.${60 + a}`, stranger);
      await expect(pending('198.51.100.90', 'x=y')).rejects.toThrow('HTTP 429');
      // Владелец с другого адреса — открывает терминал как обычно.
      await owner.connect(url, cookie, from('198.51.100.91'));
      expect((await owner.until((m) => m.t === 'y' || m.t === 'e')).t).toBe('y');
    } finally {
      sessions.get = original;
      for (const ws of opened) ws.terminate();
      owner.ws?.terminate();
    }
  });

  it('поток попыток без входа не пишет в Журнал по строке на каждую: предел в минуту с адреса', async () => {
    const db = app.get<Db>(DB);
    const IP = '198.51.100.40';
    // Отказы с этого адреса: в записи Журнала теперь есть адрес, откуда стучались.
    const denied = async () =>
      Number(
        (
          await db.execute<{ n: string }>(
            sql`select count(*)::text as n from audit_log where action = 'server.terminal.denied' and target_id = ${serverId} and host(ip::inet) = ${IP}`,
          )
        ).rows[0]?.n ?? 0,
      );
    const clients: TermClient[] = [];
    try {
      for (let i = 0; i < 20; i += 1) {
        const term = new TermClient();
        clients.push(term);
        await term.connect(`${wsBase}/ws/terminal?server=${serverId}`, 'x=y', { 'x-forwarded-for': IP });
        await term.until((m) => m.t === 'e');
      }
    } finally {
      for (const t of clients) t.ws?.terminate();
    }
    await new Promise((r) => setTimeout(r, 300));
    const written = await denied();
    // С одного адреса — не больше пяти записей в минуту (на стыке двух минут — десяти), остальное в сводку.
    expect(written).toBeGreaterThanOrEqual(1);
    expect(written).toBeLessThanOrEqual(10);
  });
});
