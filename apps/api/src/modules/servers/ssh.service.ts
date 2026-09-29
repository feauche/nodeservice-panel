import { createHash } from 'node:crypto';
import type { Duplex } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import { Injectable, Logger } from '@nestjs/common';
import { EMPTY_FACTS, type ServerFacts } from '@nodeservice/shared';
import { Client, type ConnectConfig } from 'ssh2';
import { serverProblems } from './servers.problems.js';
import { normalizePrivateKey, privateKeyProblem } from './ssh-key.js';

export interface SshTarget {
  host: string;
  port: number;
  user: string;
  /** OpenSSH/PEM приватный ключ ИЛИ пароль. */
  privateKey?: string;
  passphrase?: string;
  password?: string;
  /**
   * Пользователь не root: команды панели выполняются через `sudo -n` (без пароля). Проверяется при
   * подключении; нужен NOPASSWD в sudoers.
   */
  sudo?: boolean;
  /** Ожидаемый отпечаток host key («SHA256:…»); не совпал → hostKeyMismatch. */
  expectedHostKeyFp?: string;
}

export interface SshExecStreamOptions {
  /** Свой таймаут: длинные команды (apt upgrade) живут дольше обычных 20 с. */
  timeoutMs?: number;
  /** Вывод по мере появления (stdout и stderr вперемешку, как в терминале). */
  onData?: (chunk: string) => void;
  /** Внешняя отмена: команда обрывается закрытием соединения. */
  signal?: AbortSignal;
}

export interface SshSession {
  hostKeyFp: string;
  exec(command: string): Promise<{ code: number; stdout: string; stderr: string }>;
  /** Команда от имени самого пользователя, без sudo (например, свой ~/.ssh). */
  execAsUser(command: string): Promise<{ code: number; stdout: string; stderr: string }>;
  /** Долгая команда с живым выводом; сам вывод не копится — только код завершения. */
  execStream(command: string, opts?: SshExecStreamOptions): Promise<{ code: number }>;
  /** Соединение с другим адресом через этот сервер (для входа «через ступеньку»). */
  forward(host: string, port: number): Promise<Duplex>;
  end(): void;
}

/** Интерактивная PTY-сессия для веб-терминала. */
export interface SshShell {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  onData(cb: (chunk: string) => void): void;
  onClose(cb: (code: number | null) => void): void;
  close(): void;
}

const CONNECT_TIMEOUT_MS = 12_000;
const EXEC_TIMEOUT_MS = 20_000;
const OUTPUT_MAX = 256 * 1024;

/** Ключ или пароль в настройки ssh2; ключ сначала выправляем и проверяем, что он читается. */
function applyAuth(config: ConnectConfig, target: SshTarget): void {
  if (target.privateKey) {
    const key = normalizePrivateKey(target.privateKey);
    const bad = privateKeyProblem(key, target.passphrase);
    if (bad) throw serverProblems.sshAuth(bad);
    config.privateKey = key;
    if (target.passphrase) config.passphrase = target.passphrase;
  } else if (target.password) {
    config.password = target.password;
  } else {
    throw serverProblems.sshAuth('Не задан способ входа: ключ или пароль.');
  }
}

/** Сервер отказал во входе: что проверить. */
function authFailed(target: SshTarget): string {
  return target.privateKey
    ? `Сервер не принял ключ. Проверьте, что открытая часть этого ключа есть в ~/.ssh/authorized_keys пользователя «${target.user}» и что вход по ключу на сервере разрешён.`
    : 'Сервер не принял пароль. Проверьте пароль и пользователя; на некоторых серверах вход по паролю выключен.';
}

/** Строка в одинарных кавычках для sh. */
export function shellQuote(s: string): string {
  return `'${s.replaceAll("'", `'\\''`)}'`;
}

/** Почему sudo не пустил — и что сделать владельцу. */
export function sudoAdvice(stderr: string, user: string): string {
  if (/command not found|not found/i.test(stderr))
    return 'На сервере нет sudo. Войдите под root или установите sudo.';
  if (/password is required|terminal is required|askpass/i.test(stderr))
    return `sudo просит пароль. Разрешите «${user}» sudo без пароля: на сервере выполните от root «echo '${user} ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/nodeservice && chmod 440 /etc/sudoers.d/nodeservice» — или войдите под root.`;
  return `«${user}» нельзя запускать команды через sudo. Войдите под root или добавьте пользователя в sudoers с NOPASSWD.`;
}

/** Отпечаток в нотации OpenSSH. */
export function fingerprintSha256(key: Buffer): string {
  return `SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}`;
}

/**
 * Тонкая обёртка над ssh2: подключение с проверкой host key (TOFU), exec с таймаутом,
 * сбор фактов о сервере. Ошибки — сразу в problem+json (см. servers.problems).
 */
@Injectable()
export class SshService {
  private readonly log = new Logger(SshService.name);

  /**
   * Подключение к серверу. `via` — «ступенька»: панель напрямую до сервера не достаёт (путь закрыт у хостера),
   * а другой сервер парка достаёт — заходим на него и уже оттуда открываем соединение к цели (как ProxyJump).
   * Host key цели проверяется так же, как при прямом входе.
   */
  async connect(target: SshTarget, opts: { via?: SshTarget } = {}): Promise<SshSession> {
    let jump: SshSession | null = null;
    let sock: Duplex | undefined;
    if (opts.via) {
      jump = await this.connect(opts.via);
      try {
        sock = await jump.forward(target.host, target.port);
      } catch (err) {
        jump.end();
        throw serverProblems.sshUnreachable(
          target.host,
          `через ${opts.via.host}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    try {
      const session = await this.connectDirect(target, sock);
      if (!jump) return session;
      const j = jump;
      return { ...session, end: () => (session.end(), j.end()) };
    } catch (err) {
      jump?.end();
      throw err;
    }
  }

  private async connectDirect(target: SshTarget, sock?: Duplex): Promise<SshSession> {
    const client = new Client();
    let hostKeyFp = '';
    const config: ConnectConfig = {
      host: target.host,
      port: target.port,
      username: target.user,
      ...(sock ? { sock } : {}),
      readyTimeout: CONNECT_TIMEOUT_MS,
      // На всякий случай: панель никогда не пробует agent/интерактивные методы.
      tryKeyboard: false,
      hostVerifier: (key: Buffer) => {
        hostKeyFp = fingerprintSha256(key);
        // Несовпадение обрываем сами после события: hostVerifier не умеет отдать причину.
        return !target.expectedHostKeyFp || hostKeyFp === target.expectedHostKeyFp;
      },
    };
    applyAuth(config, target);

    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error & { level?: string }) => {
        client.end();
        if (target.expectedHostKeyFp && hostKeyFp && hostKeyFp !== target.expectedHostKeyFp) {
          reject(serverProblems.hostKeyMismatch(target.expectedHostKeyFp, hostKeyFp));
          return;
        }
        if (err.level === 'client-authentication') {
          reject(serverProblems.sshAuth(authFailed(target)));
          return;
        }
        this.log.warn({ host: target.host, err: err.message }, 'SSH недоступен');
        reject(serverProblems.sshUnreachable(target.host, err.message));
      };
      client.once('ready', () => {
        client.removeListener('error', onError);
        resolve();
      });
      client.once('error', onError);
      client.connect(config);
    });

    const asRoot = (command: string) => (target.sudo ? `sudo -n sh -c ${shellQuote(command)}` : command);
    const session: SshSession = {
      hostKeyFp,
      end: () => client.end(),
      forward: (host, port) =>
        new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('таймаут соединения')), CONNECT_TIMEOUT_MS);
          client.forwardOut('127.0.0.1', 0, host, port, (err, stream) => {
            clearTimeout(timer);
            if (err) reject(err);
            else resolve(stream);
          });
        }),
      execStream: (command, opts = {}) =>
        new Promise((resolve, reject) => {
          const timeoutMs = opts.timeoutMs ?? EXEC_TIMEOUT_MS;
          let settled = false;
          const finish = (fn: () => void) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            opts.signal?.removeEventListener('abort', onAbort);
            fn();
          };
          const timer = setTimeout(() => {
            client.end();
            finish(() =>
              reject(
                serverProblems.sshCommand(command.slice(0, 60), `таймаут ${Math.round(timeoutMs / 1000)} с`),
              ),
            );
          }, timeoutMs);
          const onAbort = () => {
            client.end();
            finish(() => reject(serverProblems.sshCommand(command.slice(0, 60), 'отменено')));
          };
          if (opts.signal?.aborted) {
            onAbort();
            return;
          }
          opts.signal?.addEventListener('abort', onAbort, { once: true });
          client.exec(asRoot(command), (err, stream) => {
            if (err) {
              finish(() => reject(serverProblems.sshCommand(command.slice(0, 60), err.message)));
              return;
            }
            // UTF-8 может разрываться между чанками — декодеры копят «хвост» до полного символа.
            const out = new StringDecoder('utf8');
            const errDec = new StringDecoder('utf8');
            stream.on('data', (d: Buffer) => opts.onData?.(out.write(d)));
            stream.stderr.on('data', (d: Buffer) => opts.onData?.(errDec.write(d)));
            stream.on('close', (code: number | null) => finish(() => resolve({ code: code ?? -1 })));
          });
        }),
      exec: (command) => runPlain(asRoot(command)),
      execAsUser: (command) => runPlain(command),
    };
    function runPlain(command: string): Promise<{ code: number; stdout: string; stderr: string }> {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          client.end();
          reject(serverProblems.sshCommand(command, 'таймаут выполнения'));
        }, EXEC_TIMEOUT_MS);
        client.exec(command, (err, stream) => {
          if (err) {
            clearTimeout(timer);
            reject(serverProblems.sshCommand(command, err.message));
            return;
          }
          let stdout = '';
          let stderr = '';
          stream.on('data', (d: Buffer) => {
            if (stdout.length < OUTPUT_MAX) stdout += d.toString('utf8');
          });
          stream.stderr.on('data', (d: Buffer) => {
            if (stderr.length < OUTPUT_MAX) stderr += d.toString('utf8');
          });
          stream.on('close', (code: number | null) => {
            clearTimeout(timer);
            resolve({ code: code ?? -1, stdout, stderr });
          });
        });
      });
    }
    if (target.sudo) {
      const chk = await session.execAsUser('sudo -n true');
      if (chk.code !== 0) {
        client.end();
        throw serverProblems.sudoRequired(target.user, sudoAdvice(chk.stderr, target.user));
      }
    }
    return session;
  }

  /** Открыть PTY по SSH для веб-терминала (host key проверяется так же, как в connect). */
  async openShell(target: SshTarget, size: { cols: number; rows: number }): Promise<SshShell> {
    const client = new Client();
    let hostKeyFp = '';
    const config: ConnectConfig = {
      host: target.host,
      port: target.port,
      username: target.user,
      readyTimeout: CONNECT_TIMEOUT_MS,
      tryKeyboard: false,
      hostVerifier: (key: Buffer) => {
        hostKeyFp = fingerprintSha256(key);
        return !target.expectedHostKeyFp || hostKeyFp === target.expectedHostKeyFp;
      },
    };
    applyAuth(config, target);

    return new Promise<SshShell>((resolve, reject) => {
      const onError = (err: Error & { level?: string }) => {
        client.end();
        if (target.expectedHostKeyFp && hostKeyFp && hostKeyFp !== target.expectedHostKeyFp)
          reject(serverProblems.hostKeyMismatch(target.expectedHostKeyFp, hostKeyFp));
        else if (err.level === 'client-authentication') reject(serverProblems.sshAuth(authFailed(target)));
        else reject(serverProblems.sshUnreachable(target.host, err.message));
      };
      client.once('error', onError);
      client.once('ready', () => {
        client.removeListener('error', onError);
        client.shell({ term: 'xterm-256color', cols: size.cols, rows: size.rows }, (err, stream) => {
          if (err) {
            client.end();
            reject(serverProblems.sshCommand('shell', err.message));
            return;
          }
          client.on('error', () => {});
          // UTF-8 может разрываться между чанками SSH — декодер копит «хвост» до полного символа.
          const decoder = new StringDecoder('utf8');
          const errDecoder = new StringDecoder('utf8');
          resolve({
            write: (data) => stream.write(data),
            resize: (cols, rows) => stream.setWindow(rows, cols, 0, 0),
            onData: (cb) => {
              stream.on('data', (b: Buffer) => cb(decoder.write(b)));
              stream.stderr.on('data', (b: Buffer) => cb(errDecoder.write(b)));
            },
            onClose: (cb) => stream.on('close', (code: number | null) => cb(code ?? null)),
            close: () => client.end(),
          });
        });
      });
      client.connect(config);
    });
  }

  /**
   * Факты о сервере одной командой (посимвольно устойчиво к отсутствию утилит).
   * Ничего не меняет на сервере.
   */
  async gatherFacts(session: SshSession): Promise<ServerFacts> {
    const cmd = [
      'echo "@@hostname=$(hostname 2>/dev/null)"',
      'echo "@@arch=$(uname -m 2>/dev/null)"',
      'echo "@@kernel=$(uname -r 2>/dev/null)"',
      'echo "@@cores=$(nproc 2>/dev/null)"',
      'echo "@@memkb=$(grep MemTotal /proc/meminfo 2>/dev/null | tr -dc 0-9)"',
      '. /etc/os-release 2>/dev/null && echo "@@os=$NAME" && echo "@@osver=$VERSION_ID"',
    ].join('; ');
    const { stdout } = await session.exec(cmd);
    const get = (name: string): string | null => {
      const m = stdout.match(new RegExp(`^@@${name}=(.*)$`, 'm'));
      const v = m?.[1]?.trim();
      return v ? v : null;
    };
    const memKb = Number(get('memkb'));
    const cores = Number(get('cores'));
    return {
      ...EMPTY_FACTS,
      hostname: get('hostname'),
      os: get('os'),
      osVersion: get('osver'),
      arch: get('arch'),
      kernel: get('kernel'),
      cpuCores: Number.isFinite(cores) && cores > 0 ? cores : null,
      memoryMb: Number.isFinite(memKb) && memKb > 0 ? Math.round(memKb / 1024) : null,
    };
  }

  /** Установить публичный ключ панели в authorized_keys (идемпотентно, с правами 600/700). */
  async installAuthorizedKey(session: SshSession, publicKeyLine: string): Promise<void> {
    const line = publicKeyLine.replaceAll("'", '');
    const cmd = `mkdir -p ~/.ssh && chmod 700 ~/.ssh && touch ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys && grep -qxF '${line}' ~/.ssh/authorized_keys || echo '${line}' >> ~/.ssh/authorized_keys`;
    // В ~/.ssh самого пользователя, под которым входит панель, — не через sudo (иначе ключ ляжет к root).
    const res = await session.execAsUser(cmd);
    if (res.code !== 0)
      throw serverProblems.sshCommand('установка ключа панели', res.stderr || `код ${res.code}`);
  }
}
