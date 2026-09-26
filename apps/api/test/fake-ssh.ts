import { generateKeyPairSync } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { Server as SshServer } from 'ssh2';

import { toOpenSshPrivate } from '../src/modules/servers/panel-key.service.js';

export const SSH_USER = 'root';
export const SSH_PASSWORD = 'server-root-password';

/** Что «печатает» тестовый сервер на узкие проверки: ключ — метка после `# ns-inspect:`. */
export const INSPECT_OUTPUT: Record<string, string> = {
  containers: [
    '/remnanode|remnawave/node:latest|exited|4|137|true|2026-09-25T10:00:00Z|2026-09-25T11:00:00Z|',
    '/nginx|nginx:1.27|running|0|0|false|2026-09-20T10:00:00Z|0001-01-01T00:00:00Z|healthy',
    '',
  ].join('\n'),
  ports: [
    'tcp   LISTEN 0      4096         0.0.0.0:443        0.0.0.0:*    users:(("xray",pid=812,fd=7))',
    'tcp   LISTEN 0      128             [::]:22             [::]:*    users:(("sshd",pid=1,fd=3))',
    'tcp   LISTEN 0      4096       127.0.0.1:8080      0.0.0.0:*    users:(("panel",pid=99,fd=5))',
    '',
  ].join('\n'),
  disk: '@@df\n/dev/vda1 50G 45G 5G 90% /\n@@du\n30G\t/var\n@@docker\nImages 3\n@@journal\nArchived and active journals take up 1.2G in the file system.\n',
  kernel: '[Sat Sep 26 12:00:00 2026] Out of memory: Killed process 812 (xray) total-vm:900000kB\n',
  cert: 'subject=CN = example.com\nissuer=C = US, O = Lets Encrypt, CN = R11\nnotBefore=Aug 27 00:00:00 2026 GMT\nnotAfter=Nov 25 00:00:00 2026 GMT\nX509v3 Subject Alternative Name: \n    DNS:example.com\n',
  'logs:agent':
    '2026-09-26T12:00:00+0000 host nodeservice-agent[1]: connect ok\n2026-09-26T12:00:05+0000 host nodeservice-agent[1]: auth failed token=abcdef123456789 from 203.0.113.44\n',
  'node-logs': 'xray started\nerror: timeout reading 203.0.113.44\n',
};

/** Мини-SSH-сервер в процессе (ssh2.Server): пароль, публичный ключ, exec фактов и authorized_keys. */
export class FakeSsh {
  server!: SshServer;
  port = 0;
  hostKey!: string;
  /** Строки, «дописанные» в authorized_keys. */
  installedKeys: string[] = [];
  execLog: string[] = [];
  /** Сколько «временных файлов старше часа» осмотр диска находит на тестовом сервере. */
  inspectTmpGb = 3.5;
  /** Обслуживание: сколько обновлений «видит» apt и падает ли шаг с этим маркером. */
  /** Проверка доступности: ответы проверяющих по очереди (open | closed), пустая очередь — open. */
  reachQueue: Array<'open' | 'closed'> = [];
  reachDns = '203.0.113.7';
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
              if (info.command.includes('# ns-inspect:')) {
                // Узкие инструменты чтения (J2): по метке в первой строке команды отдаём типичный вывод.
                const kind = /# ns-inspect:([a-z-]+(?::[a-z]+)?)/.exec(info.command)?.[1] ?? '';
                stream.write(INSPECT_OUTPUT[kind] ?? `неизвестная метка ${kind}\n`);
                stream.exit(0);
              } else if (info.command.includes('@@hostname')) {
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
              } else if (info.command.includes('ns-reach')) {
                const state = this.reachQueue.shift() ?? 'open';
                const ports = (info.command.match(/for p in ([0-9 ]+);/)?.[1] ?? '').trim().split(/\s+/);
                for (const p of ports)
                  stream.write(state === 'open' ? `tcp ${p} open 12\n` : `tcp ${p} closed\n`);
                stream.write(`dns ${this.reachDns}\n`);
                stream.exit(0);
              } else if (info.command.includes('== cpu')) {
                stream.write(
                  '== cpu\n 812 root xray 87.5 3.1\n 1 root systemd 0.1 0.2\n== mem\n 812 root xray 87.5 3.1\n 990 root dockerd 0.4 2.0\n== load\n4.20 3.90 2.10 2/321 9999\n',
                );
                stream.exit(0);
              } else if (info.command.includes('du -xh')) {
                // Осмотр диска: много коротких кусков вывода подряд — так и проявляется гонка записи лога и шагов.
                for (let i = 0; i < 160; i++) stream.write(`${i}.0G\t/var/lib/каталог-${i}\n`);
                stream.write(`Временных файлов старше часа: ${this.inspectTmpGb.toFixed(1)} ГБ\n`);
                stream.exit(0);
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
