import { createHash } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import { Injectable, Logger } from '@nestjs/common';
import { EMPTY_FACTS, type ServerFacts } from '@nodeservice/shared';
import { Client, type ConnectConfig } from 'ssh2';

import { serverProblems } from './servers.problems.js';

export interface SshTarget {
  host: string;
  port: number;
  user: string;
  /** OpenSSH/PEM приватный ключ ИЛИ пароль. */
  privateKey?: string;
  passphrase?: string;
  password?: string;
  /** Ожидаемый отпечаток host key («SHA256:…»); не совпал → hostKeyMismatch. */
  expectedHostKeyFp?: string;
}

export interface SshSession {
  hostKeyFp: string;
  exec(command: string): Promise<{ code: number; stdout: string; stderr: string }>;
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

  async connect(target: SshTarget): Promise<SshSession> {
    const client = new Client();
    let hostKeyFp = '';
    const config: ConnectConfig = {
      host: target.host,
      port: target.port,
      username: target.user,
      readyTimeout: CONNECT_TIMEOUT_MS,
      // На всякий случай: панель никогда не пробует agent/интерактивные методы.
      tryKeyboard: false,
      hostVerifier: (key: Buffer) => {
        hostKeyFp = fingerprintSha256(key);
        // Несовпадение обрываем сами после события: hostVerifier не умеет отдать причину.
        return !target.expectedHostKeyFp || hostKeyFp === target.expectedHostKeyFp;
      },
    };
    if (target.privateKey) {
      config.privateKey = target.privateKey;
      if (target.passphrase) config.passphrase = target.passphrase;
    } else if (target.password) {
      config.password = target.password;
    } else {
      throw serverProblems.sshAuth('Не задан способ входа: ключ или пароль.');
    }

    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error & { level?: string }) => {
        client.end();
        if (target.expectedHostKeyFp && hostKeyFp && hostKeyFp !== target.expectedHostKeyFp) {
          reject(serverProblems.hostKeyMismatch(target.expectedHostKeyFp, hostKeyFp));
          return;
        }
        if (err.level === 'client-authentication') {
          reject(serverProblems.sshAuth());
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

    return {
      hostKeyFp,
      end: () => client.end(),
      exec: (command) =>
        new Promise((resolve, reject) => {
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
        }),
    };
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
    if (target.privateKey) {
      config.privateKey = target.privateKey;
      if (target.passphrase) config.passphrase = target.passphrase;
    } else if (target.password) {
      config.password = target.password;
    } else {
      throw serverProblems.sshAuth('Не задан способ входа: ключ или пароль.');
    }

    return new Promise<SshShell>((resolve, reject) => {
      const onError = (err: Error & { level?: string }) => {
        client.end();
        if (target.expectedHostKeyFp && hostKeyFp && hostKeyFp !== target.expectedHostKeyFp)
          reject(serverProblems.hostKeyMismatch(target.expectedHostKeyFp, hostKeyFp));
        else if (err.level === 'client-authentication') reject(serverProblems.sshAuth());
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
    const res = await session.exec(cmd);
    if (res.code !== 0)
      throw serverProblems.sshCommand('установка ключа панели', res.stderr || `код ${res.code}`);
  }
}
