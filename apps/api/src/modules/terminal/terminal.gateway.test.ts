import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { type AddressInfo, connect, type Socket } from 'node:net';
import type { Duplex } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';

import { PREAUTH_CLOSE_GRACE_MS } from '../../infra/ws/ws-preauth.js';
import type { UpgradeHandler } from '../../infra/ws/ws-upgrade.service.js';
import { TerminalGateway } from './terminal.gateway.js';
import type { TerminalSession } from './terminal.service.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const SERVER_ID = '0192d000-0000-7000-8000-000000000001';

/**
 * Шлюз терминала принимает соединение ещё до проверки входа. Битый или слишком большой кадр WebSocket
 * библиотека сообщает событием 'error' — без слушателя это исключение мимо всех try/catch.
 */
describe('TerminalGateway: мусор в сокете не роняет панель', () => {
  const uncaught: unknown[] = [];
  const onUncaught = (err: unknown) => uncaught.push(err);
  let http: Server;
  let port = 0;
  /** Кого пускаем: null — без входа. */
  let session: { userId: string; lockedAt: string | null } | null = null;
  let open: () => Promise<TerminalSession>;

  beforeEach(async () => {
    uncaught.length = 0;
    session = null;
    open = async () => ({ write: () => {}, resize: () => {}, close: () => {} });
    process.on('uncaughtException', onUncaught);
    let handler: UpgradeHandler | null = null;
    const gateway = new TerminalGateway(
      { open: () => open() } as never,
      { get: async () => session } as never,
      { register: () => () => {} } as never,
      { findById: async () => ({ login: 'admin' }) } as never,
      { names: { session: 'ns_session' } } as never,
      {
        register: (_path: string, h: UpgradeHandler) => {
          handler = h;
        },
        clientIp: () => '127.0.0.1',
      } as never,
      { record: async () => undefined } as never,
      { record: async () => undefined } as never,
    );
    gateway.register();
    http = createServer();
    http.on('upgrade', (req, socket: Duplex, head) => handler?.(req, socket, head));
    await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
    port = (http.address() as AddressInfo).port;
  });
  afterEach(async () => {
    process.off('uncaughtException', onUncaught);
    http.closeAllConnections();
    await new Promise((resolve) => http.close(resolve));
  });

  /** Сырой сокет после рукопожатия WebSocket: дальше можно слать любые байты. */
  async function rawSocket(cookie = ''): Promise<Socket> {
    const sock = connect(port, '127.0.0.1');
    sock.on('error', () => {});
    await new Promise<void>((resolve) => sock.once('connect', () => resolve()));
    sock.write(
      [
        `GET /ws/terminal?server=${SERVER_ID}&cols=80&rows=24 HTTP/1.1`,
        `Host: 127.0.0.1:${port}`,
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Key: ${randomBytes(16).toString('base64')}`,
        'Sec-WebSocket-Version: 13',
        ...(cookie ? [`Cookie: ${cookie}`] : []),
        '',
        '',
      ].join('\r\n'),
    );
    await new Promise<void>((resolve) => sock.once('data', () => resolve()));
    return sock;
  }
  const closed = (sock: Socket) =>
    Promise.race([
      new Promise<string>((resolve) => sock.once('close', () => resolve('закрыт'))),
      sleep(2_000),
    ]);

  it('кадр без маски от клиента без входа: соединение закрыто, процесс жив', async () => {
    const sock = await rawSocket();
    const end = closed(sock);
    sock.write(Buffer.from([0x81, 0x02, 0x68, 0x69]));
    expect(await end).toBe('закрыт');
    await sleep(100);
    expect(uncaught).toEqual([]);
  });

  it('сообщение больше предела: соединение закрыто сразу, процесс жив', async () => {
    const sock = await rawSocket();
    const end = closed(sock);
    // Заголовок кадра с заявленной длиной 16 МБ (маска есть) — сами данные слать не нужно.
    const header = Buffer.alloc(14);
    header[0] = 0x82;
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(16n * 1024n * 1024n, 2);
    sock.write(header);
    expect(await end).toBe('закрыт');
    await sleep(100);
    expect(uncaught).toEqual([]);
  });

  it('сокет оборвался, пока открывался терминал: сессия на сервере закрывается, а не остаётся висеть', async () => {
    session = { userId: 'u1', lockedAt: null };
    const close = vi.fn();
    let ready!: (s: TerminalSession) => void;
    open = () =>
      new Promise((resolve) => {
        ready = resolve;
      });
    const sock = await rawSocket('ns_session=abc');
    await sleep(50);
    sock.write(Buffer.from([0x81, 0x02, 0x68, 0x69]));
    await closed(sock);
    ready({ write: () => {}, resize: () => {}, close });
    await sleep(100);
    expect(close).toHaveBeenCalledTimes(1);
    expect(uncaught).toEqual([]);
  });
});

/**
 * Окно терминала переживает экран блокировки (оно только спрятано), поэтому граница — на сервере:
 * каждый кадр от браузера проверяется по сессии панели, а не только подключение.
 */
describe('TerminalGateway: ввод в открытый терминал — только при живой и незаблокированной сессии', () => {
  let http: Server;
  let port = 0;
  /** Сессия панели, как её видит хранилище; null — сессии нет (выход, истёк срок). */
  let session: { id: string; userId: string; lockedAt: string | null } | null = null;
  /** Хранилище сессий недоступно. */
  let storeDown = false;
  let revokeSession = () => {};
  const shell = { write: vi.fn(), resize: vi.fn(), close: vi.fn() };
  const clients: WebSocket[] = [];

  beforeEach(async () => {
    session = { id: 'abc', userId: 'u1', lockedAt: null };
    storeDown = false;
    revokeSession = () => {};
    shell.write.mockReset();
    shell.resize.mockReset();
    shell.close.mockReset();
    let handler: UpgradeHandler | null = null;
    const gateway = new TerminalGateway(
      { open: async () => shell } as never,
      {
        get: async () => {
          if (storeDown) throw new Error('хранилище недоступно');
          return session;
        },
      } as never,
      {
        register: (_id: string, close: () => void) => {
          revokeSession = close;
          return () => {
            revokeSession = () => {};
          };
        },
      } as never,
      { findById: async () => ({ login: 'admin' }) } as never,
      { names: { session: 'ns_session' } } as never,
      {
        register: (_path: string, h: UpgradeHandler) => {
          handler = h;
        },
        // Адрес клиента — для предела подключений без входа.
        clientIp: () => '127.0.0.1',
      } as never,
      { record: async () => undefined } as never,
    );
    gateway.register();
    http = createServer();
    http.on('upgrade', (req, socket: Duplex, head) => handler?.(req, socket, head));
    await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
    port = (http.address() as AddressInfo).port;
  });
  afterEach(async () => {
    for (const ws of clients.splice(0)) ws.terminate();
    http.closeAllConnections();
    await new Promise((resolve) => http.close(resolve));
  });

  /** Открытый терминал: сокет с cookie сессии, сервер ответил «готово» ({t:'y'}). */
  async function openTerminal(): Promise<{ ws: WebSocket; closeCode: Promise<number> }> {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/terminal?server=${SERVER_ID}&cols=80&rows=24`, {
      headers: { cookie: 'ns_session=abc' },
    });
    clients.push(ws);
    const closeCode = new Promise<number>((resolve) => ws.once('close', (code) => resolve(code)));
    await new Promise<void>((resolve, reject) => {
      ws.on('message', (raw) => {
        if ((JSON.parse(String(raw)) as { t: string }).t === 'y') resolve();
      });
      ws.once('error', reject);
    });
    return { ws, closeCode };
  }
  const send = (ws: WebSocket, msg: unknown) => ws.send(JSON.stringify(msg));
  const typed = () => shell.write.mock.calls.map(([d]) => d as string);

  it('экран заблокирован: ввод до оболочки не доходит, размер окна доходит; после пароля ввод снова идёт', async () => {
    const { ws } = await openTerminal();
    send(ws, { t: 'i', d: 'ls\r' });
    await vi.waitFor(() => expect(typed()).toEqual(['ls\r']));

    if (session) session.lockedAt = new Date().toISOString();
    send(ws, { t: 'i', d: 'id\r' });
    send(ws, { t: 'r', c: 100, r: 30 });
    // Кадры обрабатываются по порядку: раз размер дошёл, ввод перед ним уже разобран — и отброшен.
    await vi.waitFor(() => expect(shell.resize).toHaveBeenCalledWith(100, 30));
    expect(typed()).toEqual(['ls\r']);

    if (session) session.lockedAt = null;
    send(ws, { t: 'i', d: 'pwd\r' });
    await vi.waitFor(() => expect(typed()).toEqual(['ls\r', 'pwd\r']));
    // Терминал всё это время жив: блокировка его не закрывает.
    expect(ws.readyState).toBe(WebSocket.OPEN);
    expect(shell.close).not.toHaveBeenCalled();
  });

  it('сессии панели больше нет (выход, «Завершить сессию» с другого устройства): первый же кадр закрывает терминал кодом 4401', async () => {
    const { ws, closeCode } = await openTerminal();
    session = null;
    send(ws, { t: 'i', d: 'whoami\r' });
    expect(await closeCode).toBe(4401);
    expect(typed()).toEqual([]);
    // В историю и Журнал — настоящая причина, а не «закрыт пользователем».
    expect(shell.close).toHaveBeenCalledWith('сессия панели завершена');
  });

  it('отзыв сессии сам закрывает бездействующий root-терминал, без нового кадра', async () => {
    const { closeCode } = await openTerminal();
    revokeSession();
    expect(await closeCode).toBe(4401);
    expect(shell.close).toHaveBeenCalledWith('сессия панели завершена');
  });

  it('хранилище сессий не ответило: ввод не пропускаем, а следующие кадры разбираются как обычно', async () => {
    const { ws } = await openTerminal();
    storeDown = true;
    send(ws, { t: 'i', d: 'id\r' });
    await sleep(100);
    storeDown = false;
    send(ws, { t: 'i', d: 'ls\r' });
    await vi.waitFor(() => expect(typed()).toEqual(['ls\r']));
    expect(ws.readyState).toBe(WebSocket.OPEN);
  });
});

/**
 * «Прихожая» терминала (5 соединений без входа с адреса, 50 всего) не должна закрывать терминал владельцу:
 * отказанные соединения без входа разрываются, даже если клиент молчит, а владелец с действующей сессией
 * проходит и при занятой прихожей.
 */
describe('TerminalGateway: соединения без входа не закрывают терминал владельцу', () => {
  let http: Server;
  let port = 0;
  const sockets: Socket[] = [];
  /** Проверка сессии: владелец — действующая, «stuck» — не отвечает (прихожая занята), остальные — нет. */
  const lookup = async (sid: string) =>
    sid === 'owner' ? { userId: 'u1', lockedAt: null } : sid === 'stuck' ? new Promise<null>(() => {}) : null;

  beforeEach(async () => {
    let handler: UpgradeHandler | null = null;
    const gateway = new TerminalGateway(
      { open: async () => ({ write: () => {}, resize: () => {}, close: () => {} }) } as never,
      { get: lookup } as never,
      { register: () => () => {} } as never,
      { findById: async () => ({ login: 'admin' }) } as never,
      { names: { session: 'ns_session' } } as never,
      {
        register: (_path: string, h: UpgradeHandler) => {
          handler = h;
        },
        // Адрес клиента — как его дал бы X-Forwarded-For от Caddy.
        clientIp: (req: IncomingMessage) => String(req.headers['x-test-ip'] ?? '127.0.0.1'),
      } as never,
      { record: async () => undefined } as never,
      { record: async () => undefined } as never,
    );
    gateway.register();
    http = createServer();
    http.on('upgrade', (req, socket: Duplex, head) => handler?.(req, socket, head));
    await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
    port = (http.address() as AddressInfo).port;
  });
  afterEach(async () => {
    for (const s of sockets.splice(0)) s.destroy();
    http.closeAllConnections();
    await new Promise((resolve) => http.close(resolve));
  });

  /** Клиент без входа: рукопожатие, дальше молчит и на кадр закрытия не отвечает. Ответ панели — первой строкой. */
  async function silent(ip: string, cookie = ''): Promise<{ sock: Socket; status: string }> {
    const sock = connect(port, '127.0.0.1');
    sock.on('error', () => {});
    sockets.push(sock);
    await new Promise<void>((resolve) => sock.once('connect', () => resolve()));
    sock.write(
      [
        `GET /ws/terminal?server=${SERVER_ID} HTTP/1.1`,
        `Host: 127.0.0.1:${port}`,
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Key: ${randomBytes(16).toString('base64')}`,
        'Sec-WebSocket-Version: 13',
        `X-Test-Ip: ${ip}`,
        ...(cookie ? [`Cookie: ${cookie}`] : []),
        '',
        '',
      ].join('\r\n'),
    );
    const first = await new Promise<Buffer>((resolve) => sock.once('data', resolve));
    return { sock, status: first.toString().split('\r\n')[0] ?? '' };
  }

  /** Браузер с cookie: первое сообщение панели или код отказа до рукопожатия. */
  const browser = (ip: string, cookie: string) =>
    new Promise<string>((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/terminal?server=${SERVER_ID}`, {
        headers: { cookie, 'x-test-ip': ip },
      });
      ws.on('error', () => {});
      ws.once('unexpected-response', (_req, res) => {
        ws.terminate();
        resolve(`HTTP ${res.statusCode}`);
      });
      ws.once('message', (raw) => {
        ws.terminate();
        resolve(String(raw));
      });
    });

  it('прихожая занята с десяти адресов — владелец с действующей сессией всё равно входит, чужие получают 429', async () => {
    for (let a = 1; a <= 10; a += 1)
      for (let i = 0; i < 5; i += 1)
        expect((await silent(`203.0.113.${a}`, 'ns_session=stuck')).status).toBe(
          'HTTP/1.1 101 Switching Protocols',
        );
    expect(await browser('198.51.100.77', 'ns_session=owner')).toBe('{"t":"y"}');
    // Тот же адрес, что у занявших прихожую, — владельцу тоже не помеха.
    expect(await browser('203.0.113.1', 'ns_session=owner')).toBe('{"t":"y"}');
    expect(await browser('198.51.100.78', 'ns_session=nobody')).toBe('HTTP 429');
    expect((await silent('198.51.100.79')).status).toBe('HTTP/1.1 429 Too Many Requests');
  });

  it('отказ без входа: клиент молчит на закрытие — через секунду соединение разорвано, место свободно', async () => {
    const quiet = await Promise.all(Array.from({ length: 5 }, () => silent('203.0.113.50')));
    for (const q of quiet) expect(q.status).toBe('HTTP/1.1 101 Switching Protocols');
    const dropped = await Promise.race([
      Promise.all(quiet.map((q) => new Promise((resolve) => q.sock.once('close', resolve)))).then(
        () => 'разорваны',
      ),
      sleep(PREAUTH_CLOSE_GRACE_MS + 1_000).then(() => 'висят'),
    ]);
    expect(dropped).toBe('разорваны');
    expect((await silent('203.0.113.50')).status).toBe('HTTP/1.1 101 Switching Protocols');
  });

  it('cookie с битой кодировкой — обычный отказ входа, а не соединение, висящее без ответа', async () => {
    expect(await browser('198.51.100.80', 'ns_session=%E0%A4%A')).toBe('{"t":"e","m":"Требуется вход"}');
  });
});
