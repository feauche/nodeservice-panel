import { generateKeyPairSync } from 'node:crypto';
import { type AddressInfo, connect as tcpConnect } from 'node:net';
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
  /** J10: что «печатает» проверка блокировки (ns-blockcheck) — одна строка JSON вида parseBlockCheckOutput. */
  blockCheckOutput = '{"stage":"data","ok":true,"stalledAtKb":null}';
  /** Проверка только порта (имя маскировки пустое, так идёт встречная проверка из-за рубежа); null — как blockCheckOutput. */
  blockCheckPortOnlyOutput: string | null = null;
  /** Ёмкость: что печатает опрос сетевой карты и замер скорости. */
  linkProbe = '@@dev=eth0\n@@speed=10000\n@@driver=virtio_net\n@@virt=kvm\n@@ctmax=262144\n';
  speedTest = '@@down=900000000\n@@up=612000000\n@@downms=8000\n@@upms=8000\n';
  /** Реестр проверок (ns-check): вывод по ключу и код выхода (по умолчанию 0). */
  checks: { output: Record<string, string>; code: Record<string, number> } = { output: {}, code: {} };
  /** «Куда сервер может выйти» (ns-egress): метки целей, которые «не подключаются»; пинг панели. */
  egressClosed: string[] = [];
  egressPing = true;
  /** Сколько раз через этот сервер открывали соединение к другому («ступенька»). */
  forwards = 0;
  /** Установка агента панелью (ns-agent:install): что «печатает» скрипт и с каким кодом завершается. */
  agentInstall = { code: 0, output: '' };

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
          // Вход «через ступеньку»: панель просит этот сервер открыть TCP к цели.
          client.on('tcpip', (accept, _reject, info) => {
            this.forwards += 1;
            const channel = accept();
            const sock = tcpConnect(info.destPort, info.destIP);
            sock.on('error', () => channel.close());
            channel.on('error', () => sock.destroy());
            channel.pipe(sock).pipe(channel);
          });
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
              if (info.command.includes('# ns-egress')) {
                // Строки вида «0 open 12»: цели по порядку из команды, закрытые — по адресу цели.
                const hosts = [...info.command.matchAll(/\/dev\/tcp\/([^/]+)\/(\d+)/g)].map(
                  (m) => m[1] ?? '',
                );
                const out = hosts.map((h, i) =>
                  this.egressClosed.includes(h) ? `${i} closed` : `${i} open ${10 + i}`,
                );
                if (info.command.includes('ping -c')) out.push(this.egressPing ? 'ping ok' : 'ping fail');
                stream.write(`${out.join('\n')}\n`);
                stream.exit(0);
              } else if (info.command.includes('# ns-inspect:')) {
                // Узкие инструменты чтения (J2): по метке в первой строке команды отдаём типичный вывод.
                const kind = /# ns-inspect:([a-z-]+(?::[a-z]+)?)/.exec(info.command)?.[1] ?? '';
                stream.write(INSPECT_OUTPUT[kind] ?? `неизвестная метка ${kind}\n`);
                stream.exit(0);
              } else if (info.command.includes('@@ctmax')) {
                // Ёмкость: сетевая карта маршрута по умолчанию.
                stream.write(this.linkProbe);
                stream.exit(0);
              } else if (info.command.includes('speed.cloudflare.com')) {
                // Замер скорости: 8 с по 4 потока в каждую сторону.
                stream.write(this.speedTest);
                stream.exit(0);
              } else if (info.command.includes('@@hostname')) {
                stream.write(
                  '@@hostname=test-node\n@@arch=x86_64\n@@kernel=6.8.0\n@@cores=4\n@@memkb=8192000\n@@ips=198.51.100.7 10.0.0.2 172.17.0.1 198.51.100.8 \n@@os=Ubuntu\n@@osver=24.04\n',
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
              } else if (info.command.startsWith('# ns-check:')) {
                const key = info.command.split('\n')[0]?.replace('# ns-check:', '') ?? '';
                stream.write(
                  this.checks.output[key] ?? `\u001b[32mпроверка ${key}\u001b[0m\n10%\r100%\nготово\n`,
                );
                stream.exit(this.checks.code[key] ?? 0);
              } else if (info.command.includes('# ns-agent:install')) {
                if (this.agentInstall.output) stream.write(this.agentInstall.output);
                stream.exit(this.agentInstall.code);
              } else if (info.command.includes('# ns-blockcheck')) {
                const portOnly = info.command.replaceAll("'\\''", "'").includes("sni=''\n");
                stream.write(
                  `${portOnly && this.blockCheckPortOnlyOutput !== null ? this.blockCheckPortOnlyOutput : this.blockCheckOutput}\n`,
                );
                stream.exit(0);
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
