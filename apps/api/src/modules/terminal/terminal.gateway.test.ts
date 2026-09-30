import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { type AddressInfo, connect, type Socket } from 'node:net';
import type { Duplex } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
      { findById: async () => ({ login: 'admin' }) } as never,
      { names: { session: 'ns_session' } } as never,
      {
        register: (_path: string, h: UpgradeHandler) => {
          handler = h;
        },
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
