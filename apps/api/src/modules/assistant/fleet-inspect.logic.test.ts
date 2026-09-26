import { describe, expect, it } from 'vitest';

import {
  CONTAINERS_COMMAND,
  certCommand,
  clampInt,
  DISK_COMMAND,
  isContainerName,
  isServerName,
  KERNEL_COMMAND,
  LOGS_CHARS,
  logsCommand,
  nodeLogsCommand,
  PORTS_COMMAND,
  parseCert,
  parseContainers,
  parseDisk,
  parseKernel,
  parsePorts,
  prepareLogs,
} from './fleet-inspect.logic.js';

/** Ничего из этого в командах чтения быть не должно: запись, удаление, остановка, перезапуск, произвольные загрузки. */
const FORBIDDEN =
  /\brm\b|\bmv\b|(^|[\s;&|(])kill\s|restart|\bstop\b|\bstart\b|reboot|shutdown|>\s*\/(?!dev\/null)|\bcurl\b|\bwget\b|\bchmod\b|prune|\bdd\b/;

describe('команды J2: только чтение и с меткой', () => {
  const cmds: Record<string, string> = {
    containers: CONTAINERS_COMMAND,
    ports: PORTS_COMMAND,
    disk: DISK_COMMAND,
    kernel: KERNEL_COMMAND,
    cert: certCommand(443, 'example.com'),
    'logs agent': logsCommand('agent', 60, 80) ?? '',
    'logs ssh': logsCommand('ssh', 60, 80) ?? '',
    'logs docker': logsCommand('docker', 60, 80) ?? '',
    'logs system': logsCommand('system', 60, 80) ?? '',
    'logs container': logsCommand('container', 60, 80, 'remnanode') ?? '',
    node: nodeLogsCommand(30, 50),
  };
  for (const [name, cmd] of Object.entries(cmds)) {
    it(`${name}: есть метка ns-inspect, нет записи и остановок`, () => {
      expect(cmd, name).toContain('# ns-inspect:');
      expect(cmd, name).toMatch(/^sh -c '/);
      expect(cmd, name).not.toMatch(FORBIDDEN);
    });
  }
});

describe('проверка аргументов', () => {
  it('clampInt держит границы и подставляет запасное значение', () => {
    expect(clampInt(5000, 1, 200, 80)).toBe(200);
    expect(clampInt(-4, 10, 200, 80)).toBe(10);
    expect(clampInt('мусор', 10, 200, 80)).toBe(80);
    expect(clampInt(undefined, 10, 200, 80)).toBe(80);
    expect(clampInt(12.6, 1, 200, 80)).toBe(13);
  });
  it('имя контейнера: только допустимые символы, без пробелов, кавычек и ведущего дефиса', () => {
    for (const ok of ['remnanode', 'my_app-1', 'nginx.proxy']) expect(isContainerName(ok), ok).toBe(true);
    for (const bad of [
      '',
      '-x',
      'a b',
      'a;rm -rf /',
      '$(id)',
      'a`b`',
      "a'b",
      'a"b',
      '../etc',
      'x'.repeat(80),
    ])
      expect(isContainerName(bad), bad).toBe(false);
  });
  it('журнал контейнера с плохим именем и неизвестная цель не строятся', () => {
    expect(logsCommand('container', 60, 80, 'a;rm -rf /')).toBeNull();
    expect(logsCommand('container', 60, 80)).toBeNull();
    expect(logsCommand('shell', 60, 80)).toBeNull();
    expect(logsCommand('agent; reboot', 60, 80)).toBeNull();
  });
  it('период и число строк ограничены, в команду попадают только числа', () => {
    const c = logsCommand('agent', 999_999, 99_999) ?? '';
    expect(c).toContain('1440 minutes ago');
    expect(c).toContain('-n 200');
    const d = logsCommand('agent', Number.NaN, Number.NaN) ?? '';
    expect(d).toContain('60 minutes ago');
    expect(d).toContain('-n 80');
    expect(logsCommand('container', 30, 50, 'remnanode')).toContain(
      'docker logs --since 30m --tail 50 "remnanode"',
    );
  });
  it('servername сертификата проверяется, чужая строка в команду не попадает', () => {
    expect(isServerName('example.com')).toBe(true);
    expect(isServerName('a..b')).toBe(false);
    expect(isServerName('a b')).toBe(false);
    expect(isServerName('x;reboot')).toBe(false);
    expect(certCommand(443, 'x;reboot')).not.toContain('reboot');
    expect(certCommand(443, 'x;reboot')).not.toContain('-servername');
    expect(certCommand(8443, 'example.com')).toContain('-servername example.com');
    expect(certCommand(8443)).toContain('127.0.0.1');
  });
});

describe('parseContainers', () => {
  const OUT = [
    '/remnanode|remnawave/node:latest|running|0|0|false|2026-09-20T10:00:00.1Z|0001-01-01T00:00:00Z|healthy',
    '/nginx|nginx:1.27|exited|1|137|true|2026-09-25T10:00:00Z|2026-09-25T11:00:00Z|',
    '/loop|app:1|restarting|12|1|false|2026-09-26T09:00:00Z|2026-09-26T09:00:05Z|unhealthy',
  ].join('\n');
  it('поля разобраны, нулевое время Docker превращается в null', () => {
    const r = parseContainers(OUT);
    expect(r.docker).toBe(true);
    expect(r.containers).toHaveLength(3);
    expect(r.containers[0]).toMatchObject({
      name: 'remnanode',
      image: 'remnawave/node:latest',
      state: 'running',
      restarts: 0,
      oomKilled: false,
      finishedAt: null,
      health: 'healthy',
    });
    expect(r.containers[1]).toMatchObject({ name: 'nginx', exitCode: 137, oomKilled: true, health: null });
  });
  it('внимание: остановлен, OOM, много перезапусков, нездоров', () => {
    const a = parseContainers(OUT).attention.join(' | ');
    expect(a).toContain('nginx: не работает (exited, код выхода 137)');
    expect(a).toContain('nginx: убит из-за нехватки памяти (OOM)');
    expect(a).toContain('loop: постоянно перезапускается');
    expect(a).toContain('loop: 12 перезапусков');
    expect(a).toContain('loop: проверка здоровья не проходит');
    expect(a).not.toContain('remnanode');
  });
  it('нет docker и пустой список — без падения', () => {
    expect(parseContainers('@@nodocker\n')).toEqual({ docker: false, containers: [], attention: [] });
    expect(parseContainers('@@empty\n')).toEqual({ docker: true, containers: [], attention: [] });
    expect(parseContainers('мусор без разделителей').containers).toEqual([]);
  });
});

describe('parsePorts', () => {
  const OUT = [
    'tcp   LISTEN 0      4096         0.0.0.0:443        0.0.0.0:*    users:(("xray",pid=812,fd=7))',
    'tcp   LISTEN 0      128             [::]:22             [::]:*    users:(("sshd",pid=1,fd=3))',
    'tcp   LISTEN 0      4096       127.0.0.1:8080      0.0.0.0:*    users:(("panel",pid=99,fd=5))',
    'udp   UNCONN 0      0      127.0.0.53%lo:53        0.0.0.0:*    users:(("systemd-resolve",pid=500,fd=13))',
    'udp   UNCONN 0      0                  *:51820            *:*',
    'tcp   LISTEN 0      128             [::1]:631              *:*',
    'tcp   LISTEN 0      128             [::]:22             [::]:*    users:(("sshd",pid=1,fd=4))',
  ].join('\n');
  it('порт, процесс, доступность снаружи; повторы (ipv4 и ipv6 одного процесса) схлопываются', () => {
    const r = parsePorts(OUT);
    expect(r.available).toBe(true);
    expect(r.ports.map((p) => `${p.proto}:${p.port}:${p.process}:${p.exposed}`)).toEqual([
      'tcp:22:sshd:true',
      'udp:53:systemd-resolve:false',
      'tcp:443:xray:true',
      'tcp:631:null:false',
      'tcp:8080:panel:false',
      'udp:51820:null:true',
    ]);
  });
  it('нет ss и пустой вывод', () => {
    expect(parsePorts('@@noss')).toEqual({ available: false, ports: [] });
    expect(parsePorts('')).toEqual({ available: true, ports: [] });
  });
});

describe('parseDisk и parseKernel', () => {
  it('секции диска разбираются по маркерам и обрезаются', () => {
    const out = `@@df\nFilesystem Size Used Avail Use% Mounted on\n/dev/vda1 50G 45G 5G 90% /\n@@du\n${'x'.repeat(3000)}\n@@docker\nTYPE TOTAL\nImages 3\n@@journal\nArchived and active journals take up 1.2G in the file system.\n`;
    const r = parseDisk(out);
    expect(r.filesystems).toContain('90% /');
    expect(r.biggestDirs.length).toBeLessThanOrEqual(1601);
    expect(r.docker).toContain('Images 3');
    expect(r.journal).toContain('1.2G');
    expect(parseDisk('').filesystems).toBe('');
  });
  it('события ядра: не больше сорока, адреса маскируются', () => {
    const lines = Array.from(
      { length: 60 },
      (_, i) =>
        `[Sat Sep 26 12:${String(i).padStart(2, '0')}:00 2026] Out of memory: Killed process ${i} (xray) from 203.0.113.${i}`,
    );
    const r = parseKernel(lines.join('\n'));
    expect(r.events).toHaveLength(40);
    expect(r.events[39]).toContain('Killed process 59');
    expect(r.events.join('\n')).not.toContain('203.0.113.5');
    expect(parseKernel('').events).toEqual([]);
  });
});

describe('parseCert', () => {
  const NOW = Date.parse('2026-09-26T00:00:00Z');
  const OUT = [
    'subject=CN = example.com',
    "issuer=C = US, O = Let's Encrypt, CN = R11",
    'notBefore=Aug 27 00:00:00 2026 GMT',
    'notAfter=Nov 25 00:00:00 2026 GMT',
    'X509v3 Subject Alternative Name: ',
    '    DNS:example.com, DNS:www.example.com',
  ].join('\n');
  it('владелец, издатель, даты, дни до окончания и имена', () => {
    const r = parseCert(OUT, NOW);
    expect(r).toMatchObject({
      present: true,
      subject: 'CN = example.com',
      notAfter: '2026-11-25T00:00:00.000Z',
      daysLeft: 60,
      names: ['example.com', 'www.example.com'],
    });
    expect(r.issuer).toContain("Let's Encrypt");
  });
  it('уже истёк — отрицательные дни; порт без сертификата — present=false', () => {
    expect(parseCert('notAfter=Sep 20 00:00:00 2026 GMT', NOW).daysLeft).toBe(-6);
    expect(parseCert('@@nocert')).toMatchObject({ present: false, daysLeft: null });
  });
});

describe('prepareLogs', () => {
  it('секреты и адреса скрыты, длинное режется с начала', () => {
    const r = prepareLogs(`user 203.0.113.9 token=abcdef123456\n${'строка '.repeat(2000)}\nконец`);
    expect(r.truncated).toBe(true);
    expect(r.text.length).toBeLessThanOrEqual(LOGS_CHARS);
    expect(r.text.endsWith('конец')).toBe(true);
    const small = prepareLogs('token=abcdef123456 и адрес 203.0.113.9');
    expect(small.text).not.toContain('abcdef123456');
    expect(small.text).not.toContain('203.0.113.9');
    expect(small.masked).toBeGreaterThanOrEqual(2);
  });
  it('contains оставляет строки со словом без учёта регистра и считает совпадения', () => {
    const r = prepareLogs('Error: timeout\nok\nERROR again\nfine');
    const f = prepareLogs('Error: timeout\nok\nERROR again\nfine', 'error');
    expect(r.matched).toBeNull();
    expect(f.matched).toBe(2);
    expect(f.text).toBe('Error: timeout\nERROR again');
    expect(prepareLogs('a\nb', 'нет').text).toBe('');
  });
});
