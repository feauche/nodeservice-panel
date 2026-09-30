import type { ReachabilityResult, Server } from '@nodeservice/shared';
import { describe, expect, it } from 'vitest';

import {
  buildReachCommand,
  dnsSummary,
  isProbeHost,
  mergeReach,
  NODE_LOGS_CHARS,
  NODE_LOGS_COMMAND,
  normalizePorts,
  PROCESSES_COMMAND,
  parsePs,
  parseReach,
  pickProbes,
  prepareNodeLogs,
  probesForAddress,
  REACH_NOTES,
  sameReachTarget,
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
    const names = pickProbes(target, all, 3).map((s) => s.name);
    expect(names).toHaveLength(3);
    expect(names.slice(0, 2)).toEqual(['a', 'c']);
    expect(names).not.toContain('b');
  });
  it('сначала по одному из каждой страны, российский — первым', () => {
    const c = (code: string) => ({ code, name: code }) as Server['country'];
    const all = [
      target,
      srv({ name: 'de1', host: '5.5.5.1', providerId: 'p1', country: c('DE') }),
      srv({ name: 'de2', host: '6.6.6.1', providerId: 'p2', country: c('DE') }),
      srv({ name: 'fi', host: '7.7.7.1', providerId: 'p1', country: c('FI') }),
      srv({ name: 'ru', host: '8.8.8.1', providerId: 'p1', country: c('RU') }),
    ];
    expect(pickProbes(target, all, 3).map((s) => s.name)).toEqual(['ru', 'de1', 'fi']);
  });
  it('шесть стран и пять мест: российский сервер не выпадает из проверки', () => {
    const c = (code: string) => ({ code, name: code }) as Server['country'];
    const all = [
      target,
      ...(['DE', 'KZ', 'LV', 'NL', 'PL'] as const).map((code, i) =>
        srv({ name: `a-${code}`, host: `5.5.${i}.1`, country: c(code) }),
      ),
      srv({ name: 'я-россия', host: '8.8.8.1', country: c('RU') }),
    ];
    const names = pickProbes(target, all).map((s) => s.name);
    expect(names).toHaveLength(5);
    expect(names[0]).toBe('я-россия');
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
  it('проверяемая машина не проверяет себя ни под какой своей записью', () => {
    const all = [
      srv({ name: 'сам сервер', host: 'NL1.example.com.' }),
      srv({ name: 'его вторая запись', host: 'nl1.example.com' }),
      srv({ name: 'мост', host: '2.2.2.2' }),
      srv({ name: 'другой', host: '3.3.3.3' }),
    ];
    // Адрес цели — тот же, что у двух записей; мост исключён явно (проверяем его же вход).
    expect(probesForAddress('nl1.example.com', all, ['id-мост']).map((s) => s.name)).toEqual(['другой']);
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
    expect(r.ping).toBeNull();
    expect(parseReach('tcp 22 open 5\nping 41.7\n', [22]).ping).toBe(42);
    expect(parseReach('ping none\n', [22]).ping).toBeNull();
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

describe('mergeReach: несколько проверок одной цели — одна таблица', () => {
  const one = (
    from: string,
    ports: Array<[number, boolean]>,
    over: Partial<ReachabilityResult['probes'][number]> = {},
  ): ReachabilityResult['probes'][number] => ({
    from,
    ok: true,
    error: null,
    ports: ports.map(([port, open]) => ({ port, open, ms: open ? 12 : null })),
    dns: '201.34.145.175',
    ping: null,
    ...over,
  });
  /** Результат одной проверки так, как его собирает служба: вывод по портам, DNS и оговорки. */
  const result = (
    probes: ReachabilityResult['probes'],
    ports: number[],
    target = { name: 'Нидерланды - 1', address: '201.34.145.175' },
  ): ReachabilityResult => ({
    target,
    probes,
    ports: summarizeReach(probes, ports),
    dns: dnsSummary(probes),
    notes: [...(probes.length < 2 ? [REACH_NOTES.single] : []), REACH_NOTES.notUserView],
  });

  it('случай владельца: шесть проверок по одному серверу — шесть строк, а не последняя', () => {
    const from = ['Мост', 'Россия - 1', 'Германия - 1', 'Казахстан - 1', 'Польша - 1', 'Нидерланды - 2'];
    const open = [false, false, true, true, true, true];
    const merged = from
      .map((name, i) => result([one(name, [[443, open[i] as boolean]])], [443]))
      .reduce(mergeReach);
    expect(merged.probes.map((p) => p.from)).toEqual(from);
    expect(merged.ports).toHaveLength(1);
    // Из России порт не отвечал — «открыт со всех» по последней проверке было бы неправдой.
    expect(merged.ports[0]).toMatchObject({ port: 443, open: 4, closed: 2, verdict: 'partial' });
    // Проверяющих шесть — оговорка «проверяющий один» больше не к месту.
    expect(merged.notes).not.toContain(REACH_NOTES.single);
    expect(merged.notes.at(-1)).toBe(REACH_NOTES.notUserView);
  });

  it('повторная проверка с того же сервера заменяет его прежний ответ, а не добавляет строку', () => {
    const merged = mergeReach(
      result([one('Мост', [[443, false]]), one('Польша - 1', [[443, true]])], [443]),
      result([one('Мост', [[443, true]])], [443]),
    );
    expect(merged.probes.map((p) => p.from)).toEqual(['Мост', 'Польша - 1']);
    expect(merged.ports[0]).toMatchObject({ open: 2, closed: 0, verdict: 'reachable' });
  });

  it('разные порты складываются в столбцы: кто какой порт не проверял, в выводе не считается', () => {
    const merged = mergeReach(
      result([one('Мост', [[22, true]]), one('Польша - 1', [[22, true]])], [22]),
      result([one('Мост', [[443, false]])], [443]),
    );
    expect(merged.ports.map((p) => p.port)).toEqual([22, 443]);
    expect(merged.probes.find((p) => p.from === 'Мост')?.ports.map((p) => p.port)).toEqual([22, 443]);
    expect(merged.probes.find((p) => p.from === 'Польша - 1')?.ports.map((p) => p.port)).toEqual([22]);
    expect(merged.ports[1]).toMatchObject({ port: 443, open: 0, closed: 1, verdict: 'closed_everywhere' });
    expect(merged.ports[1]?.text).toContain('1 проверяющего сервера');
  });

  it('проверяющий не ответил во второй раз — то, что он видел раньше, остаётся', () => {
    const dead = one('Мост', [], { ok: false, error: 'Не удалось подключиться к проверяющему серверу.' });
    const merged = mergeReach(result([one('Мост', [[443, true]])], [443]), result([dead], [443]));
    expect(merged.probes).toHaveLength(1);
    expect(merged.probes[0]).toMatchObject({ ok: true, ports: [{ port: 443, open: true, ms: 12 }] });
    expect(merged.notes).not.toContain(REACH_NOTES.silent);
    // А если он не отвечал и раньше — строка «не ответил» остаётся, с оговоркой.
    const both = mergeReach(result([dead], [443]), result([one('Польша - 1', [[443, true]])], [443]));
    expect(both.probes.map((p) => p.ok)).toEqual([false, true]);
    expect(both.notes).toContain(REACH_NOTES.silent);
  });

  it('расхождение DNS между проверками попадает в оговорки', () => {
    const merged = mergeReach(
      result([one('Мост', [[443, true]], { dns: '1.1.1.1' })], [443]),
      result([one('Польша - 1', [[443, true]], { dns: '2.2.2.2' })], [443]),
    );
    expect(merged.dns).toEqual({ answers: ['1.1.1.1', '2.2.2.2'], consistent: false });
    expect(merged.notes[0]).toContain('DNS отвечает по-разному');
  });

  it('одна цель — тот же адрес; имя может быть названием сервера или самим адресом', () => {
    const byName = result([one('Мост', [[443, true]])], [443]);
    const byAddress = result([one('Польша - 1', [[443, true]])], [443], {
      name: '201.34.145.175',
      address: '201.34.145.175',
    });
    expect(sameReachTarget(byName, byAddress)).toBe(true);
    // В заголовке остаётся название сервера, а не голый адрес.
    expect(mergeReach(byAddress, byName).target.name).toBe('Нидерланды - 1');
    expect(mergeReach(byName, byAddress).target.name).toBe('Нидерланды - 1');
    const other = result([one('Мост', [[443, true]])], [443], { name: 'Германия - 1', address: '5.5.5.5' });
    expect(sameReachTarget(byName, other)).toBe(false);
    // Вход сервера и сам сервер — разные цели, даже если адрес один.
    const entry = result([one('Мост', [[443, true]])], [443], {
      name: 'Вход «Нидерланды - 1»: 201.34.145.175:443',
      address: '201.34.145.175',
    });
    expect(sameReachTarget(byName, entry)).toBe(false);
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
