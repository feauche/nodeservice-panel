import type { Server } from '@nodeservice/shared';
import { describe, expect, it } from 'vitest';

import {
  buildReachCommand,
  dnsSummary,
  isProbeHost,
  NODE_LOGS_CHARS,
  NODE_LOGS_COMMAND,
  normalizePorts,
  PROCESSES_COMMAND,
  parsePs,
  parseReach,
  pickProbes,
  prepareNodeLogs,
  summarizeReach,
} from './fleet-probe.logic.js';

const srv = (over: Partial<Server> & { name: string }): Server =>
  ({
    id: `id-${over.name}`,
    host: '10.0.0.1',
    port: 22,
    providerId: null,
    sshOk: true,
    ...over,
  }) as Server;

describe('isProbeHost', () => {
  it('имена и IPv4 подходят', () => {
    for (const h of ['example.com', 'de-1.node.example.org', '203.0.113.7'])
      expect(isProbeHost(h)).toBe(true);
  });
  it('всё, что можно превратить в команду, отвергается', () => {
    for (const h of [
      'a; rm -rf /',
      '$(id)',
      '`id`',
      'a b',
      '-oProxyCommand=x',
      'a..b',
      '::1',
      '',
      'a|b',
      "a'b",
      'a\nb',
    ])
      expect(isProbeHost(h), h).toBe(false);
  });
});

describe('normalizePorts', () => {
  it('целые 1–65535, без повторов, не больше трёх', () => {
    expect(normalizePorts([443, 443, 22, 8443, 9999], 22)).toEqual([443, 22, 8443]);
  });
  it('мусор и пустое заменяются портом по умолчанию', () => {
    expect(normalizePorts(undefined, 5492)).toEqual([5492]);
    expect(normalizePorts(['x', 0, 70000, 1.5, -1], 22)).toEqual([22]);
    expect(normalizePorts(443, 22)).toEqual([443]);
  });
});

describe('pickProbes', () => {
  const target = srv({ name: 'target', host: '1.1.1.1' });
  it('не берёт сам сервер и серверы без работающего SSH', () => {
    const all = [
      target,
      srv({ name: 'a', host: '2.2.2.2' }),
      srv({ name: 'b', host: '3.3.3.3', sshOk: false }),
      srv({ name: 'c', host: '4.4.4.4', sshOk: null }),
    ];
    expect(pickProbes(target, all).map((s) => s.name)).toEqual(['a']);
  });
  it('сначала разные хостеры и подсети, потом добор', () => {
    const all = [
      target,
      srv({ name: 'a', host: '2.2.2.1', providerId: 'p1' }),
      srv({ name: 'b', host: '2.2.2.2', providerId: 'p1' }),
      srv({ name: 'c', host: '3.3.3.3', providerId: 'p2' }),
      srv({ name: 'd', host: '4.4.4.4', providerId: 'p2' }),
    ];
    const names = pickProbes(target, all).map((s) => s.name);
    expect(names).toHaveLength(3);
    expect(names.slice(0, 2)).toEqual(['a', 'c']);
    expect(names).not.toContain('b');
  });
  it('не больше max и без адресов, непригодных для команды', () => {
    const all = [
      target,
      ...['a', 'b', 'c', 'd', 'e'].map((n, i) => srv({ name: n, host: `9.9.${i}.1` })),
      srv({ name: 'v6', host: '::1' }),
    ];
    const chosen = pickProbes(target, all, 2);
    expect(chosen).toHaveLength(2);
    expect(pickProbes(target, all).map((s) => s.name)).not.toContain('v6');
  });
  it('пусто, если проверять не с чего', () => {
    expect(pickProbes(target, [target])).toEqual([]);
  });
});

describe('buildReachCommand', () => {
  it('собирает скрипт только из проверенных частей', () => {
    const cmd = buildReachCommand('example.com', [22, 443]);
    expect(cmd.startsWith("sh -c '")).toBe(true);
    expect(cmd).toContain('h=example.com');
    expect(cmd).toContain('for p in 22 443;');
    expect(cmd).toContain('ns-reach');
    expect(cmd).not.toMatch(/rm |curl |wget |>\s*\/(etc|root|home)/);
  });
  it('плохой адрес или порты — ошибка, а не команда', () => {
    expect(() => buildReachCommand('a; reboot', [22])).toThrow();
    expect(() => buildReachCommand('example.com', [])).toThrow();
    expect(() => buildReachCommand('example.com', [0, 70000])).toThrow();
  });
});

describe('parseReach и summarizeReach', () => {
  it('разбирает вывод и игнорирует лишнее', () => {
    const r = parseReach(
      'junk\ntcp 22 open 15\ntcp 443 closed\ndns 203.0.113.7\ndns ; rm -rf\n',
      [22, 443, 8443],
    );
    expect(r.ports).toEqual([
      { port: 22, open: true, ms: 15 },
      { port: 443, open: false, ms: null },
    ]);
    expect(r.dns).toBe('203.0.113.7');
  });
  const probe = (from: string, open: boolean[], dns = '1.2.3.4') => ({
    from,
    ok: true,
    error: null,
    ports: open.map((o, i) => ({ port: [22, 443][i] as number, open: o, ms: o ? 10 : null })),
    dns,
  });
  it('открыт со всех, закрыт со всех, частично, неизвестно', () => {
    const all = summarizeReach(
      [probe('a', [true, false]), probe('b', [true, false]), probe('c', [true, true])],
      [22, 443, 8443],
    );
    expect(all.map((x) => x.verdict)).toEqual(['reachable', 'partial', 'unknown']);
    const closed = summarizeReach([probe('a', [false]), probe('b', [false])], [22]);
    expect(closed[0]?.verdict).toBe('closed_everywhere');
    expect(closed[0]?.text).toContain('закрыт со всех');
  });
  it('не ответившие проверяющие не считаются', () => {
    const dead = { from: 'x', ok: false, error: 'нет', ports: [], dns: null };
    expect(summarizeReach([dead, probe('a', [true])], [22])[0]).toMatchObject({
      open: 1,
      closed: 0,
      verdict: 'reachable',
    });
  });
  it('расхождение DNS видно', () => {
    expect(dnsSummary([probe('a', [true], '1.1.1.1'), probe('b', [true], '2.2.2.2')])).toEqual({
      answers: ['1.1.1.1', '2.2.2.2'],
      consistent: false,
    });
    expect(dnsSummary([probe('a', [true], '1.1.1.1'), probe('b', [true], '1.1.1.1')]).consistent).toBe(true);
  });
});

describe('осмотр процессов', () => {
  it('команда читает имя процесса, а не командную строку', () => {
    expect(PROCESSES_COMMAND).toContain('comm=');
    expect(PROCESSES_COMMAND).not.toMatch(/args|cmd=|command=|aux|-ef/);
  });
  it('разбирает вывод ps и load', () => {
    const r = parsePs(
      '== cpu\n 812 root xray 87.5 3.1\n 1 root systemd 0.1 0.2\n== mem\n 990 root dockerd 0.4 2.0\n== load\n4.20 3.90 2.10 2/321 9999\n',
    );
    expect(r.cpu[0]).toEqual({ pid: 812, user: 'root', name: 'xray', cpu: 87.5, mem: 3.1 });
    expect(r.mem).toHaveLength(1);
    expect(r.load).toBe('4.20 3.90 2.10');
  });
  it('мусор даёт пустой результат', () => {
    expect(parsePs('ошибка')).toEqual({ cpu: [], mem: [], load: null });
  });
});

describe('логи ноды', () => {
  it('команда только читает: docker logs с ограничением, без записи и удаления', () => {
    expect(NODE_LOGS_COMMAND).toContain('docker logs --tail');
    expect(NODE_LOGS_COMMAND).not.toMatch(/\brm\b|>\s*\/(?!dev\/null)|restart|stop|kill/);
  });
  it('секреты, uuid и публичные адреса скрываются до отправки модели', () => {
    const r = prepareNodeLogs(
      'user 0192c000-0000-4000-8000-00000000000a from 203.0.113.77 token=abcdef123456\nok',
      0,
    );
    expect(r.found).toBe(true);
    expect(r.text).not.toContain('203.0.113.77');
    expect(r.text).not.toContain('abcdef123456');
    expect(r.text).not.toContain('0192c000');
    expect(r.masked).toBeGreaterThanOrEqual(3);
    expect(r.text).toContain('ok');
  });
  it('длинный журнал обрезается с начала: последние строки важнее', () => {
    const r = prepareNodeLogs(`${'старая строка\n'.repeat(2000)}последняя`, 0);
    expect(r.text.length).toBeLessThanOrEqual(NODE_LOGS_CHARS);
    expect(r.text.endsWith('последняя')).toBe(true);
  });
  it('нет контейнера ноды — found=false, а не пустой успех', () => {
    expect(prepareNodeLogs('контейнер ноды не найден\n', 3)).toMatchObject({ found: false, lines: 0 });
  });
});
