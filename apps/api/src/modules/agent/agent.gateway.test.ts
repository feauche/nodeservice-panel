import { sign as edSign, generateKeyPairSync, randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { type AddressInfo, connect, type Socket } from 'node:net';
import type { Duplex } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';

import { PREAUTH_CLOSE_GRACE_MS } from '../../infra/ws/ws-preauth.js';
import type { UpgradeHandler } from '../../infra/ws/ws-upgrade.service.js';
import { AGENT_WS_PATH, AgentGateway, CLOSE_SERVER_DELETED } from './agent.gateway.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Denied = { action: string; target: { id: string }; metadata: { code: string; attempts: number } };

/** Шлюз без сети: Журнал — список, служба серверов запоминает слушателей удаления. */
function make() {
  const journal: Denied[] = [];
  const deleteListeners: Array<(id: string) => void> = [];
  const pullListeners: Array<(id: string) => void> = [];
  const offline: string[] = [];
  const gateway = new AgentGateway(
    {
      markOffline: async (s: { id: string }) => void offline.push(s.id),
      onPullActive: (l: (id: string) => void) => void pullListeners.push(l),
    } as never,
    {} as never,
    { record: async (e: Denied) => void journal.push(e) } as never,
    { onDeleted: (l: (id: string) => void) => void deleteListeners.push(l) } as never,
  );
  const inner = gateway as unknown as {
    authFailed: (code: string, serverId: string, name: string | null) => Promise<void>;
    active: Map<string, unknown>;
  };
  return { gateway, inner, journal, deleteListeners, pullListeners, offline };
}

describe('AgentGateway: отказы агентам в Журнале', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('агент стучится каждые 5 секунд — запись раз в час, в ней число попыток с прошлой записи', async () => {
    vi.useFakeTimers({ now: new Date('2026-09-30T00:00:00Z') });
    const ctx = make();
    // Сутки перезапусков удалённого сервера: 17 280 попыток.
    for (let i = 0; i < 17_280; i += 1) {
      await ctx.inner.authFailed('unknown-server', 'srv-1', null);
      vi.advanceTimersByTime(5_000);
    }
    expect(ctx.journal).toHaveLength(24);
    expect(ctx.journal[0]?.metadata).toEqual({ code: 'unknown-server', attempts: 1 });
    expect(ctx.journal[1]?.metadata).toEqual({ code: 'unknown-server', attempts: 720 });
    expect(ctx.journal.reduce((n, e) => n + e.metadata.attempts, 0)).toBe(17_280 - 719);
  });

  it('серверы считаются порознь', async () => {
    const ctx = make();
    for (const id of ['a', 'b', 'a', 'b', 'a']) await ctx.inner.authFailed('auth-failed', id, id);
    expect(ctx.journal.map((e) => e.target.id)).toEqual(['a', 'b']);
  });

  it('поток выдуманных серверов не раздувает ни память, ни Журнал', async () => {
    const ctx = make();
    for (let i = 0; i < 5_000; i += 1) await ctx.inner.authFailed('unknown-server', `ghost-${i}`, null);
    // По отдельности помним 500 серверов, остальные делят одну запись в час.
    expect(ctx.journal).toHaveLength(501);
    expect((ctx.gateway as unknown as { authFailures: Map<string, unknown> }).authFailures.size).toBe(501);
  });
});

describe('AgentGateway: удаление сервера', () => {
  it('соединение агента закрывается с причиной и особым кодом; «пропал со связи» не пишется', () => {
    const ctx = make();
    ctx.gateway.onModuleInit();
    const sent: string[] = [];
    const closed: Array<[number, string]> = [];
    const ws = {
      readyState: WebSocket.OPEN,
      send: (raw: string) => void sent.push(raw),
      close: (code: number, reason: string) => void closed.push([code, reason]),
    };
    ctx.inner.active.set('srv-1', ws);
    // Удаление чужого сервера это соединение не трогает.
    for (const l of ctx.deleteListeners) l('srv-2');
    expect(closed).toEqual([]);

    for (const l of ctx.deleteListeners) l('srv-1');
    expect(closed).toEqual([[CLOSE_SERVER_DELETED, 'agent revoked']]);
    expect(JSON.parse(sent[0] ?? '{}')).toMatchObject({
      type: 'error',
      payload: { code: 'unknown-server', message: 'Агент удалён или отвязан в панели' },
    });
    expect(ctx.inner.active.has('srv-1')).toBe(false);
    expect(ctx.offline).toEqual([]);
    // Повторное удаление (соединения уже нет) — тихо.
    for (const l of ctx.deleteListeners) l('srv-1');
    expect(closed).toHaveLength(1);
  });

  it('рабочий входящий агент сразу закрывает старый WebSocket той же карточки', () => {
    const ctx = make();
    ctx.gateway.onModuleInit();
    const sent: string[] = [];
    const closed: Array<[number, string]> = [];
    const ws = {
      readyState: WebSocket.OPEN,
      send: (raw: string) => void sent.push(raw),
      close: (code: number, reason: string) => void closed.push([code, reason]),
    };
    ctx.inner.active.set('srv-1', ws);

    for (const listener of ctx.pullListeners) listener('srv-1');

    expect(closed).toEqual([[CLOSE_SERVER_DELETED, 'legacy agent revoked']]);
    expect(JSON.parse(sent[0] ?? '{}')).toMatchObject({
      payload: { message: 'Панель перешла на новый входящий канал агента' },
    });
    expect(ctx.inner.active.has('srv-1')).toBe(false);
  });
});

/** Соединение без сети: входящие — событием 'message', исходящие и закрытие — в списки. */
class FakeWs extends EventEmitter {
  readyState: number = WebSocket.OPEN;
  sent: Array<{ type: string; payload: { code?: string; nonce?: string } }> = [];
  closed: Array<[number, string]> = [];
  terminated = 0;
  send(raw: string): void {
    this.sent.push(JSON.parse(raw));
  }
  close(code: number, reason: string): void {
    this.closed.push([code, reason]);
    this.readyState = WebSocket.CLOSED;
  }
  terminate(): void {
    this.terminated += 1;
  }
}

const envelope = (type: string, payload: unknown, pad = 0): Buffer =>
  Buffer.from(
    JSON.stringify({
      v: 1,
      type,
      id: '0192d000-0000-7000-8000-00000000000a',
      ts: new Date().toISOString(),
      payload,
      ...(pad ? { pad: 'x'.repeat(pad) } : {}),
    }),
  );

describe('AgentGateway: до входа — одно короткое сообщение на шаг', () => {
  const keys = generateKeyPairSync('ed25519');
  const pubkey = (keys.publicKey.export({ format: 'der', type: 'spki' }) as Buffer)
    .subarray(-32)
    .toString('base64');
  const SERVER = { id: '0192d000-0000-7000-8000-000000000001', name: 'de-1', agentPubkey: pubkey };
  const hello = envelope('hello', {
    serverId: SERVER.id,
    pubkey,
    version: 'v0.7.0',
    route: 'wss://agents.test/api/agent/v1/ws',
  });

  function setup(findServer: () => Promise<unknown> = async () => SERVER) {
    const calls = { find: 0, online: 0, onlineArgs: [] as unknown[][], touched: 0 };
    const gateway = new AgentGateway(
      {
        findServer: async () => {
          calls.find += 1;
          return findServer();
        },
        markOnline: async (...args: unknown[]) => {
          calls.online += 1;
          calls.onlineArgs.push(args);
        },
        welcomeFor: async () => ({ serverName: 'de-1', heartbeatSeconds: 10, metricsSeconds: 10 }),
        touch: async () => {
          calls.touched += 1;
          return true;
        },
        markOffline: async () => undefined,
      } as never,
      {} as never,
      { record: async () => undefined } as never,
      { onDeleted: () => undefined } as never,
    );
    const ws = new FakeWs();
    const release = vi.fn();
    (gateway as unknown as { handle: (ws: unknown, req: unknown, release: () => void) => void }).handle(
      ws,
      {},
      release,
    );
    return { ws, release, calls };
  }
  const tick = () => new Promise((r) => setTimeout(r, 10));

  it('крупное сообщение до входа — разрыв, в базу не ходим', async () => {
    const { ws, calls } = setup();
    ws.emit('message', envelope('hello', { serverId: SERVER.id, pubkey, version: '0.5.0' }, 8 * 1024));
    await tick();
    expect(ws.closed).toEqual([[4400, 'protocol']]);
    // Соединение уже закрывается: библиотека ещё отдаёт сообщения, но панель их не обрабатывает.
    ws.emit('message', hello);
    await tick();
    expect(calls.find).toBe(0);
  });

  it('второе сообщение, пока первое проверяется, — разрыв; поиск сервера — один раз', async () => {
    let answer!: (s: unknown) => void;
    const { ws, calls } = setup(() => new Promise((r) => (answer = r)));
    ws.emit('message', hello);
    ws.emit('message', hello);
    await tick();
    expect(ws.closed).toEqual([[4400, 'protocol']]);
    answer(SERVER);
    await tick();
    expect(calls.find).toBe(1);
  });

  it('не то сообщение до входа — разрыв, а не вежливая ошибка без конца', async () => {
    const { ws } = setup();
    ws.emit('message', envelope('heartbeat', {}));
    await tick();
    expect(ws.closed).toEqual([[4400, 'protocol']]);
    expect(ws.sent[0]).toMatchObject({ type: 'error', payload: { code: 'protocol' } });
  });

  it('вход не начат за 10 секунд — кадр закрытия, а молчащего клиента панель через секунду разрывает сама', () => {
    vi.useFakeTimers();
    try {
      const { ws } = setup();
      vi.advanceTimersByTime(10_000);
      expect(ws.closed).toEqual([[4401, 'auth timeout']]);
      expect(ws.terminated).toBe(0);
      vi.advanceTimersByTime(PREAUTH_CLOSE_GRACE_MS);
      expect(ws.terminated).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('после входа место в «прихожей» освобождается, и обычные сообщения больше не ограничены', async () => {
    const { ws, release, calls } = setup();
    ws.emit('message', hello);
    await tick();
    const nonce = ws.sent.find((m) => m.type === 'challenge')?.payload.nonce ?? '';
    expect(release).not.toHaveBeenCalled();
    const signature = edSign(null, Buffer.from(nonce, 'base64'), keys.privateKey).toString('base64');
    ws.emit('message', envelope('auth', { signature }));
    await tick();
    expect(ws.sent.at(-1)?.type).toBe('welcome');
    expect(release).toHaveBeenCalledTimes(1);
    expect(calls.onlineArgs[0]?.[3]).toEqual({
      transport: 'websocket',
      route: 'wss://agents.test/api/agent/v1/ws',
    });
    // Сигналы подряд и сообщение крупнее «прихожей» — обычная работа, без разрыва.
    ws.emit('message', envelope('heartbeat', {}));
    ws.emit('message', envelope('heartbeat', {}, 8 * 1024));
    await tick();
    expect(ws.closed).toEqual([]);
    expect(calls.touched).toBe(2);
  });
});

/**
 * «Прихожая» агентов (5 соединений без входа с адреса, 50 всего) не должна мешать парку переподключаться:
 * агента с адреса известного сервера пускаем и при занятой прихожей, а молчащие соединения без входа панель
 * разрывает сама, не дожидаясь ответа на закрытие.
 */
describe('AgentGateway: соединения без входа не мешают агентам парка', () => {
  let http: Server;
  let port = 0;
  let gateway: AgentGateway;
  const sockets: Socket[] = [];
  /** Серверы парка: SSH-адрес и внешние адреса на интерфейсах. */
  let fleet: Array<{ host: string; facts: { addresses: string[] } }> = [];

  beforeEach(async () => {
    fleet = [
      { host: '192.0.2.10', facts: { addresses: ['2001:db8:5:6::1'] } },
      { host: 'de1.example.com', facts: { addresses: [] } },
    ];
    let handler: UpgradeHandler | null = null;
    gateway = new AgentGateway(
      { findServer: async () => null } as never,
      {
        register: (_path: string, h: UpgradeHandler) => {
          handler = h;
        },
        // Адрес клиента — как его дал бы X-Forwarded-For от Caddy.
        clientIp: (req: IncomingMessage) => String(req.headers['x-test-ip'] ?? '127.0.0.1'),
      } as never,
      { record: async () => undefined } as never,
      { onDeleted: () => undefined, list: async () => fleet } as never,
    );
    gateway.register();
    http = createServer();
    http.on('upgrade', (req, socket: Duplex, head) => handler?.(req, socket, head));
    await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
    port = (http.address() as AddressInfo).port;
  });
  afterEach(async () => {
    for (const s of sockets.splice(0)) s.destroy();
    gateway.onModuleDestroy();
    http.closeAllConnections();
    await new Promise((resolve) => http.close(resolve));
  });

  /** Рукопожатие прошло, дальше клиент молчит и на закрытие не отвечает; first — первый ответ панели. */
  async function silent(ip: string): Promise<{ sock: Socket; first: string }> {
    const sock = connect(port, '127.0.0.1');
    sock.on('error', () => {});
    sockets.push(sock);
    await new Promise<void>((resolve) => sock.once('connect', () => resolve()));
    sock.write(
      [
        `GET ${AGENT_WS_PATH} HTTP/1.1`,
        `Host: 127.0.0.1:${port}`,
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Key: ${randomBytes(16).toString('base64')}`,
        'Sec-WebSocket-Version: 13',
        `X-Test-Ip: ${ip}`,
        '',
        '',
      ].join('\r\n'),
    );
    const first = await new Promise<Buffer>((resolve) => sock.once('data', resolve));
    return { sock, first: first.toString() };
  }

  /** Агент подключается: «открыто» или код отказа до рукопожатия. */
  const agent = (ip: string) =>
    new Promise<string>((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}${AGENT_WS_PATH}`, { headers: { 'x-test-ip': ip } });
      ws.on('error', () => {});
      ws.once('unexpected-response', (_req, res) => {
        ws.terminate();
        resolve(`HTTP ${res.statusCode}`);
      });
      ws.once('open', () => {
        ws.terminate();
        resolve('открыто');
      });
    });

  it('прихожая занята с десяти адресов — агент известного сервера входит, чужой адрес получает 429', async () => {
    for (let a = 1; a <= 10; a += 1)
      for (let i = 0; i < 5; i += 1)
        expect((await silent(`203.0.113.${a}`)).first).toMatch(/^HTTP\/1\.1 101 /);
    expect(await agent('198.51.100.99')).toBe('HTTP 429');
    expect(await agent('192.0.2.10')).toBe('открыто');
    // IPv6 — по сети /64, как у самого предела.
    expect(await agent('2001:db8:5:6::abcd')).toBe('открыто');
    // Сервер добавили только что — узнаём и его: устаревший список серверов перечитывается.
    fleet.push({ host: '192.0.2.20', facts: { addresses: [] } });
    expect(await agent('192.0.2.20')).toBe('HTTP 429');
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 5_100 });
    try {
      expect(await agent('192.0.2.20')).toBe('открыто');
    } finally {
      vi.useRealTimers();
    }
  });

  it('с адреса известного сервера — всё равно не больше пяти соединений без входа', async () => {
    for (let a = 1; a <= 10; a += 1) for (let i = 0; i < 5; i += 1) await silent(`203.0.113.${a}`);
    for (let i = 0; i < 5; i += 1) expect((await silent('192.0.2.10')).first).toMatch(/^HTTP\/1\.1 101 /);
    expect(await agent('192.0.2.10')).toBe('HTTP 429');
  });

  it('нарушил порядок до входа и молчит на закрытие — через секунду соединение разорвано, место свободно', async () => {
    const quiet = await Promise.all(Array.from({ length: 5 }, () => silent('203.0.113.60')));
    // Не то сообщение до входа (маскированный текстовый кадр «{}»).
    for (const q of quiet) q.sock.write(Buffer.from([0x81, 0x82, 1, 2, 3, 4, 0x7b ^ 1, 0x7d ^ 2]));
    const dropped = await Promise.race([
      Promise.all(quiet.map((q) => new Promise((resolve) => q.sock.once('close', resolve)))).then(
        () => 'разорваны',
      ),
      sleep(PREAUTH_CLOSE_GRACE_MS + 1_000).then(() => 'висят'),
    ]);
    expect(dropped).toBe('разорваны');
    expect((await silent('203.0.113.60')).first).toMatch(/^HTTP\/1\.1 101 /);
  });
});
