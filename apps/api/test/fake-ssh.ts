import { generateKeyPairSync } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { Server as SshServer } from 'ssh2';

import { toOpenSshPrivate } from '../src/modules/servers/panel-key.service.js';

export const SSH_USER = 'root';
export const SSH_PASSWORD = 'server-root-password';

/** Мини-SSH-сервер в процессе (ssh2.Server): пароль, публичный ключ, exec фактов и authorized_keys. */
export class FakeSsh {
  server!: SshServer;
  port = 0;
  hostKey!: string;
  /** Строки, «дописанные» в authorized_keys. */
  installedKeys: string[] = [];
  execLog: string[] = [];
  /** Обслуживание: сколько обновлений «видит» apt и падает ли шаг с этим маркером. */
  maintenance = { updates: 3, security: 1, reboot: false, failStep: '' as string };

  async start(port = 0): Promise<void> {
    this.hostKey ??= toOpenSshPrivate(generateKeyPairSync('ed25519').privateKey, 'fake-host');
    this.server = new SshServer({ hostKeys: [this.hostKey] }, (client) => {
      client
        // обрывы клиентских сокетов фейкового sshd — не наши ассерты
        .on('error', () => {})
        .on('authentication', (ctx) => {
          if (ctx.method === 'password' && ctx.username === SSH_USER && ctx.password === SSH_PASSWORD)
            return ctx.accept();
          if (ctx.method === 'publickey' && ctx.username === SSH_USER) {
            const offered = ctx.key.data.toString('base64');
            if (this.installedKeys.some((line) => line.split(' ')[1] === offered)) return ctx.accept();
          }
          return ctx.reject(['password', 'publickey']);
        })
        .on('ready', () => {
          client.on('session', (accept) => {
            const session = accept();
            let ptyCols = 80;
            session.on('pty', (acceptPty, _rejectPty, info) => {
              ptyCols = (info as { cols?: number }).cols ?? 80;
              acceptPty?.();
            });
            session.on('shell', (acceptShell) => {
              const stream = acceptShell();
              // Мини-shell: приглашение + эхо ввода (достаточно для e2e веб-терминала).
              stream.write(`node@test:~$ (${ptyCols} cols)\r\n`);
              stream.on('data', (d: Buffer) => stream.write(d));
            });
            session.on('exec', (acceptExec, _reject, info) => {
              this.execLog.push(info.command);
              const stream = acceptExec();
              if (info.command.includes('@@hostname')) {
                stream.write(
                  '@@hostname=test-node\n@@arch=x86_64\n@@kernel=6.8.0\n@@cores=4\n@@memkb=8192000\n@@os=Ubuntu\n@@osver=24.04\n',
                );
                stream.exit(0);
              } else if (info.command.startsWith('# ns-maint:check')) {
                const m = this.maintenance;
                stream.write(
                  [
                    '@@apt=1',
                    '@@apt_update=ok',
                    `@@updates=${m.updates}`,
                    `@@security=${m.security}`,
                    '@@dpkg_broken=0',
                    '@@unattended=0',
                    `@@reboot=${m.reboot ? 1 : 0}`,
                    '@@kernel_running=6.8.0-84-generic',
                    '@@kernel_installed=6.8.0-85-generic',
                    '@@agent_version=v0.5.4',
                    '@@agent_service=active',
                    '@@disk_pct=16',
                    '@@disk_free_mb=66000',
                    '@@done=1',
                    '',
                  ].join('\n'),
                );
                stream.exit(0);
              } else if (info.command.startsWith('# ns-maint:')) {
                const marker = info.command.split('\n')[0]?.replace('# ns-maint:', '') ?? '';
                if (this.maintenance.failStep && marker === this.maintenance.failStep) {
                  stream.stderr.write(`E: шаг ${marker} сломан для теста\n`);
                  stream.exit(100);
                } else {
                  stream.write(`ok: ${marker}\n`);
                  if (marker === 'apt_upgrade:upgrade') {
                    this.maintenance.updates = 0;
                    this.maintenance.security = 0;
                    this.maintenance.reboot = true;
                  }
                  stream.exit(0);
                }
              } else if (info.command.includes('authorized_keys')) {
                const m = info.command.match(/echo '([^']+)'/);
                if (m?.[1] && !this.installedKeys.includes(m[1])) this.installedKeys.push(m[1]);
                stream.exit(0);
              } else {
                stream.exit(0);
              }
              stream.end();
            });
          });
        });
    });
    await new Promise<void>((resolve) => {
      this.server.listen(port, '127.0.0.1', () => {
        this.port = (this.server.address() as AddressInfo).port;
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  /** «Переустановка сервера»: тот же порт, новый host key. */
  async reinstall(): Promise<void> {
    const port = this.port;
    await this.stop();
    this.hostKey = toOpenSshPrivate(generateKeyPairSync('ed25519').privateKey, 'fake-host-2');
    this.installedKeys = [];
    await this.start(port);
  }
}
