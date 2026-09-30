import { generateKeyPairSync } from 'node:crypto';
import { type AddressInfo, createServer, type Server, type Socket, connect as tcpConnect } from 'node:net';
import { Server as SshServer } from 'ssh2';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { errorText } from '../../common/filters/problem-details.filter.js';
import { toOpenSshPrivate } from './panel-key.service.js';
import { SshService, type SshTarget } from './ssh.service.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const listen = (srv: { listen: (port: number, host: string, cb: () => void) => unknown }) =>
  new Promise<void>((resolve) => void srv.listen(0, '127.0.0.1', resolve));

/**
 * Обрыв соединения (RST от хостера или ТСПУ, перезагрузка сервера) ssh2 сообщает событием 'error'.
 * Без слушателя это исключение мимо всех try/catch — раньше от него падал весь процесс панели.
 */
describe('SshService: обрыв соединения не роняет панель', () => {
  const uncaught: unknown[] = [];
  const onUncaught = (err: unknown) => uncaught.push(err);
  const closers: Array<() => void> = [];
  /** Соединения панели с «сервером»: сброс имитирует RST на пути. */
  const conns = new Set<Socket>();
  const reset = () => {
    for (const c of conns) c.resetAndDestroy();
  };

  /** Мини-sshd, который принимает любой вход и молчит на команды, за TCP-прослойкой с кнопкой «RST». */
  async function silentSshd(): Promise<SshTarget> {
    const hostKey = toOpenSshPrivate(generateKeyPairSync('ed25519').privateKey, 'test-host');
    const sshd = new SshServer({ hostKeys: [hostKey] }, (client) => {
      client
        .on('error', () => {})
        .on('authentication', (ctx) => ctx.accept())
        .on('ready', () => {
          client.on('session', (accept) => {
            const session = accept();
            session.on('pty', (acceptPty) => acceptPty?.());
            session.on('shell', (acceptShell) => void acceptShell());
            // Команду принимаем и молчим: ответа не будет, пока соединение не оборвётся.
            session.on('exec', (acceptExec) => void acceptExec());
          });
        });
    });
    await listen(sshd);
    const sshPort = (sshd.address() as AddressInfo).port;
    return relay(
      (c) => {
        const up = tcpConnect(sshPort, '127.0.0.1');
        up.on('error', () => c.destroy());
        c.pipe(up).pipe(c);
      },
      () => sshd.close(),
    );
  }

  /** TCP-сервер на свободном порту; все принятые соединения можно сбросить через reset(). */
  async function relay(onConn: (c: Socket) => void, alsoClose?: () => void): Promise<SshTarget> {
    const srv: Server = createServer((c) => {
      conns.add(c);
      c.on('error', () => {});
      c.on('close', () => conns.delete(c));
      onConn(c);
    });
    await listen(srv);
    closers.push(() => {
      reset();
      srv.close();
      alsoClose?.();
    });
    return { host: '127.0.0.1', port: (srv.address() as AddressInfo).port, user: 'root', password: 'x' };
  }

  beforeEach(() => {
    uncaught.length = 0;
    process.on('uncaughtException', onUncaught);
  });
  afterEach(() => {
    process.off('uncaughtException', onUncaught);
    for (const close of closers.splice(0)) close();
  });

  it('обрыв посреди команды: команда сразу завершается понятной ошибкой', async () => {
    const session = await new SshService().connect(await silentSshd());
    const started = Date.now();
    const run = session.exec('docker inspect remnanode');
    await sleep(100);
    reset();
    const err = await run.then(
      () => null,
      (e: unknown) => e,
    );
    expect(err && errorText(err)).toMatch(/соединение с сервером оборвалось/);
    // Не ждём 20 секунд таймаута команды: обрыв известен сразу.
    expect(Date.now() - started).toBeLessThan(5_000);
    await sleep(100);
    expect(uncaught).toEqual([]);
  });

  it('обрыв посреди долгой команды с живым выводом', async () => {
    const session = await new SshService().connect(await silentSshd());
    const run = session.execStream('apt-get -y upgrade', { timeoutMs: 60_000 });
    await sleep(100);
    reset();
    const err = await run.then(
      () => null,
      (e: unknown) => e,
    );
    expect(err && errorText(err)).toMatch(/соединение с сервером оборвалось/);
    await sleep(100);
    expect(uncaught).toEqual([]);
  });

  it('обрыв на простаивающей сессии и закрытие после него', async () => {
    const session = await new SshService().connect(await silentSshd());
    reset();
    await sleep(150);
    session.end();
    await sleep(100);
    expect(uncaught).toEqual([]);
  });

  it('порт принимает соединение и сбрасывает его до приветствия: вход отклонён, процесс жив', async () => {
    const target = await relay((c) => setTimeout(() => c.resetAndDestroy(), 50));
    await expect(new SshService().connect(target)).rejects.toMatchObject({ status: 502 });
    await sleep(200);
    expect(uncaught).toEqual([]);
  });

  it('сервер прислал приветствие и спокойно закрыл связь до входа: подключение отклонено, а не висит вечно', async () => {
    // ssh2 в этом случае не сообщает ни «готово», ни ошибку и снимает свой таймаут — без своей проверки
    // подключение ждало бы бесконечно, а обслуживание и починки по этому серверу замирали до перезапуска.
    const hello = (c: Socket) => {
      c.write('SSH-2.0-OpenSSH_9.6\r\n');
      setTimeout(() => c.end(), 50);
    };
    const outcome = (p: Promise<unknown>) =>
      Promise.race([
        p.then(
          () => 'подключился',
          (e: unknown) => (e as { status?: number }).status,
        ),
        sleep(3_000).then(() => 'висит'),
      ]);
    expect(await outcome(new SshService().connect(await relay(hello)))).toBe(502);
    expect(await outcome(new SshService().openShell(await relay(hello), { cols: 80, rows: 24 }))).toBe(502);
    expect(uncaught).toEqual([]);
  }, 10_000);

  it('веб-терминал: сброс до приветствия и обрыв открытого терминала', async () => {
    const dead = await relay((c) => setTimeout(() => c.resetAndDestroy(), 50));
    await expect(new SshService().openShell(dead, { cols: 80, rows: 24 })).rejects.toMatchObject({
      status: 502,
    });
    const shell = await new SshService().openShell(await silentSshd(), { cols: 80, rows: 24 });
    shell.onData(() => {});
    const closed = new Promise<void>((resolve) => shell.onClose(() => resolve()));
    reset();
    await closed;
    await sleep(100);
    expect(uncaught).toEqual([]);
  });
});
