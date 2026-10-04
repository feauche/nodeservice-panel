import { DEFAULT_SERVER_COUNTRY, type Server } from '@nodeservice/shared';
import { describe, expect, it } from 'vitest';

import { NodeBlockCheckService } from './node-block-check.service.js';
import type { UpstreamTarget } from './upstream-target.js';

const srv = (id: string, code: string | null, over: Partial<Server> = {}): Server =>
  ({
    id,
    name: id,
    host: `10.0.0.${id.length}`,
    sshOk: true,
    country: { ...DEFAULT_SERVER_COUNTRY, code },
    ...over,
  }) as Server;

const OK = '{"stage":"data","ok":true,"stalledAtKb":null}';
const PORT = '{"stage":"port","ok":true,"stalledAtKb":null}';
const DEAD = '{"stage":"tcp","ok":false,"stalledAtKb":null}';

/**
 * Служба проверки на заглушках SSH: `answers` — что отвечает команда проверки на каждом проверяющем
 * (по id сервера); 'ssh' — панель на него не зашла; 'hang' — зашла, но команда не завершилась (таймаут).
 * В `calls` — на какие серверы панель заходила.
 */
function setup(answers: Record<string, string | 'ssh' | 'hang'>) {
  const calls: string[] = [];
  const servers = { sshTargetFor: async (id: string) => ({ target: { id } }) };
  const ssh = {
    connect: async (target: { id: string }) => {
      calls.push(target.id);
      const answer = answers[target.id];
      if (answer === undefined || answer === 'ssh') throw new Error('нет связи');
      return {
        exec: async () => {
          if (answer === 'hang') throw new Error('таймаут 20 с');
          return { stdout: answer, code: 0 };
        },
        end: () => undefined,
      };
    },
  };
  const disabledVpn = { status: async () => ({ configured: false, routes: null }) };
  return {
    svc: new NodeBlockCheckService(
      servers as never,
      ssh as never,
      {} as never,
      {} as never,
      {} as never,
      disabledVpn as never,
    ),
    calls,
  };
}

describe('проверка порта ноды: почему не состоялась', () => {
  const all = [srv('exit', 'DE'), srv('ru1', 'RU'), srv('de2', 'DE')];

  it('порта нет, адрес с недопустимыми знаками, проверять не с чего, панель не зашла — четыре разные причины', async () => {
    const { svc, calls } = setup({ ru1: 'ssh' });
    expect((await svc.check('n', '1.2.3.4', null, 'site.ru', 'exit', all)).unchecked).toBe('no_port');
    expect((await svc.check('n', 'bad host;rm', 443, 'site.ru', 'exit', all)).unchecked).toBe('bad_address');
    expect((await svc.check('n', '1.2.3.4', 443, 'site.ru', 'exit', [srv('exit', 'DE')])).unchecked).toBe(
      'no_probers',
    );
    expect(calls).toEqual([]);
    // Проверяющий есть, но панель на него не зашла: проб нет — «проверить не удалось», а не «порт закрыт».
    const r = await svc.check('n', '1.2.3.4', 443, 'site.ru', 'exit', all);
    expect(r).toMatchObject({ probes: [], unchecked: 'ssh' });
  });

  it('проверяющий ответил неразборчиво (команда не отработала) — это не «порт закрыт»: такая проба не считается', async () => {
    // Единственный проверяющий вернул пустоту: о ноде ничего не известно.
    const blind = setup({ ru1: 'bash: timeout: command not found' });
    expect(await blind.svc.check('n', '1.2.3.4', 443, 'site.ru', 'exit', all)).toMatchObject({
      probes: [],
      unchecked: 'no_answer',
    });
    // Рядом есть проверяющий с настоящим ответом — итог по нему, неразборчивый в список не попал.
    const mixed = setup({ ru1: '', ru2: OK });
    const r = await mixed.svc.check('n', '1.2.3.4', 443, 'site.ru', 'exit', [...all, srv('ru2', 'RU')]);
    expect(r.verdict).toBe('ok');
    expect(r.probes.map((p) => p.from)).toEqual(['ru2']);
  });

  it('панель зашла на проверяющий, а команда не уложилась во время — это не «не зашла» и не «серверов нет»', async () => {
    const { svc } = setup({ ru1: 'hang' });
    expect(await svc.check('n', '1.2.3.4', 443, 'site.ru', 'exit', all)).toMatchObject({
      probes: [],
      unchecked: 'no_answer',
    });
  });

  it('проверка состоялась — причины нет', async () => {
    const { svc } = setup({ ru1: OK });
    expect(await svc.check('n', '1.2.3.4', 443, 'site.ru', 'exit', all)).toMatchObject({
      verdict: 'ok',
      unchecked: null,
    });
  });
});

describe('проверка обычного сервера без ноды', () => {
  it('проверяет SSH-порт как TCP и помечает область результата', async () => {
    const all = [srv('target', 'DE'), srv('ru1', 'RU'), srv('nl', 'NL')];
    const { svc } = setup({ ru1: PORT, nl: PORT });

    const result = await svc.checkServer('Обычный сервер', '1.2.3.4', 5492, 'target', all);

    expect(result).toMatchObject({
      targetKind: 'server',
      port: 5492,
      nodeName: 'Обычный сервер',
      verdict: 'ok',
      unchecked: null,
    });
    expect(result.probes[0]?.detail).toBe('Порт отвечает.');
  });
});

describe('настоящая VPN-проба через агенты', () => {
  const live = {
    agentStatus: 'online' as const,
    agentTransport: 'https' as const,
    agentVersion: 'v0.9.0',
  };
  const all = [
    srv('target', 'KZ', live),
    srv('ru1', 'RU', live),
    srv('ru2', 'RU', live),
    srv('de', 'DE', live),
    srv('nl', 'NL', live),
  ];

  function service(result: (id: string, attempt: number) => boolean | 'agent') {
    const attempts = new Map<string, number>();
    const servers = { sshTargetFor: async (id: string) => ({ target: { id } }) };
    const ssh = {
      connect: async () => ({ exec: async () => ({ stdout: OK, code: 0 }), end: () => undefined }),
    };
    const rows = { findById: async (id: string) => ({ id }) };
    const agent = {
      vpnProbe: async (row: { id: string }) => {
        const attempt = (attempts.get(row.id) ?? 0) + 1;
        attempts.set(row.id, attempt);
        const outcome = result(row.id, attempt);
        const ok = outcome === true;
        return {
          ok,
          stage: ok ? 'done' : outcome === 'agent' ? 'start' : 'connect',
          detail: ok ? 'Маршрут работает.' : outcome === 'agent' ? 'Xray не запустился.' : 'Нет связи.',
          latencyMs: 4,
          bytes: ok ? 65536 : 0,
        };
      },
    };
    return {
      svc: new NodeBlockCheckService(
        servers as never,
        ssh as never,
        rows as never,
        agent as never,
        { issue: () => 'token' } as never,
        {
          status: async () => ({ configured: true, routes: 5 }),
          routeFor: async () => 'vless://service-route',
        } as never,
      ),
      attempts,
    };
  }

  it('ставит ТСПУ только когда две точки России повторно не проходят, а зарубежные проходят', async () => {
    const { svc, attempts } = service((id) => !id.startsWith('ru'));
    const result = await svc.check('Казахстан - 1', '10.0.0.6', 443, 'mask.example', 'target', all);
    expect(result).toMatchObject({ verdict: 'tspu', vpnVerdict: 'regional_block' });
    expect(result.vpnProbes).toHaveLength(2);
    expect(result.vpnForeign).toHaveLength(2);
    expect(attempts.get('ru1')).toBe(2);
    expect(attempts.get('ru2')).toBe(2);
  });

  it('не подтверждает блокировку, если повтор настоящего VPN-сеанса прошёл', async () => {
    const { svc } = service((id, attempt) => !id.startsWith('ru') || attempt === 2);
    const result = await svc.check('Казахстан - 1', '10.0.0.6', 443, 'mask.example', 'target', all);
    expect(result).toMatchObject({ verdict: 'ok', vpnVerdict: 'ok' });
    expect(result.vpnProbes?.every((probe) => probe.ok)).toBe(true);
  });

  it('не объявляет региональную блокировку по ошибке агента или одной зарубежной точке', async () => {
    const brokenAgent = service((id) => (id === 'ru2' ? 'agent' : !id.startsWith('ru')));
    expect(
      await brokenAgent.svc.check('Казахстан - 1', '10.0.0.6', 443, 'mask.example', 'target', all),
    ).toMatchObject({ vpnVerdict: 'mixed', verdict: 'indeterminate' });

    const oneForeign = service((id) => id === 'de');
    expect(
      await oneForeign.svc.check('Казахстан - 1', '10.0.0.6', 443, 'mask.example', 'target', all),
    ).toMatchObject({ vpnVerdict: 'mixed', verdict: 'indeterminate' });
  });

  it('при массовой проверке не запускает на одном агенте больше четырёх Xray-проб', async () => {
    const active = new Map<string, number>();
    const maximum = new Map<string, number>();
    const svc = new NodeBlockCheckService(
      { sshTargetFor: async (id: string) => ({ target: { id } }) } as never,
      {
        connect: async () => ({ exec: async () => ({ stdout: OK, code: 0 }), end: () => undefined }),
      } as never,
      { findById: async (id: string) => ({ id }) } as never,
      {
        vpnProbe: async (row: { id: string }) => {
          const current = (active.get(row.id) ?? 0) + 1;
          active.set(row.id, current);
          maximum.set(row.id, Math.max(maximum.get(row.id) ?? 0, current));
          await new Promise((resolve) => setTimeout(resolve, 10));
          active.set(row.id, (active.get(row.id) ?? 1) - 1);
          return { ok: true, stage: 'done', detail: 'Маршрут работает.', latencyMs: 4, bytes: 65536 };
        },
      } as never,
      { issue: () => 'token' } as never,
      {
        status: async () => ({ configured: true, routes: 5 }),
        routeFor: async () => 'vless://service-route',
      } as never,
    );

    await Promise.all(
      Array.from({ length: 8 }, () =>
        svc.check('Казахстан - 1', '10.0.0.6', 443, 'mask.example', 'target', all),
      ),
    );

    expect([...maximum.values()]).toEqual([4, 4, 4, 4]);
  });
});

describe('проверка порта ноды: смешанная картина', () => {
  const all = [srv('exit', 'DE'), srv('ru1', 'RU'), srv('ru2', 'RU'), srv('ru3', 'RU'), srv('nl', 'NL')];

  it('с одного российского сервера проходит, с двух нет — «порт отвечает не отовсюду»; зарубежный результат тоже сохраняется', async () => {
    const { svc, calls } = setup({ ru1: OK, ru2: DEAD, ru3: DEAD, nl: PORT });
    const r = await svc.check('n', '1.2.3.4', 443, 'site.ru', 'exit', all);
    // Сервер отвечает: это не «недоступен» и не «блокировка IP из России».
    expect(r.verdict).toBe('partial');
    expect(r.foreign).toHaveLength(1);
    expect(calls).toContain('nl');
  });

  it('из России не отвечает, а из-за рубежа проверки нет — названа настоящая причина, а не «зарубежных серверов нет»', async () => {
    // Зарубежный сервер в парке есть, но панель на него не зашла.
    const noLogin = setup({ ru1: DEAD, ru2: DEAD, ru3: DEAD, nl: 'ssh' });
    expect(await noLogin.svc.check('n', '1.2.3.4', 443, 'site.ru', 'exit', all)).toMatchObject({
      verdict: 'unreachable',
      foreign: [],
      foreignUnchecked: 'ssh',
    });
    // Зашла, но команда вернула пустоту.
    const garbled = setup({ ru1: DEAD, ru2: DEAD, ru3: DEAD, nl: '' });
    expect((await garbled.svc.check('n', '1.2.3.4', 443, 'site.ru', 'exit', all)).foreignUnchecked).toBe(
      'no_answer',
    );
    // Зарубежных серверов действительно нет.
    const none = setup({ ru1: DEAD, ru2: DEAD, ru3: DEAD });
    const onlyRu = all.filter((s) => s.id !== 'nl');
    expect((await none.svc.check('n', '1.2.3.4', 443, 'site.ru', 'exit', onlyRu)).foreignUnchecked).toBe(
      'no_probers',
    );
    // Проверка из-за рубежа состоялась или не понадобилась — причины нет.
    const dead = setup({ ru1: DEAD, ru2: DEAD, ru3: DEAD, nl: DEAD });
    expect((await dead.svc.check('n', '1.2.3.4', 443, 'site.ru', 'exit', all)).foreignUnchecked).toBeNull();
    const fine = setup({ ru1: OK, ru2: OK, ru3: OK, nl: PORT });
    expect((await fine.svc.check('n', '1.2.3.4', 443, 'site.ru', 'exit', all)).foreignUnchecked).toBeNull();
  });

  it('один проверяющий подключился один раз из трёх — «порт отвечает не каждый раз», блокировку IP по нему не объявляем', async () => {
    let n = 0;
    const servers = { sshTargetFor: async (id: string) => ({ target: { id } }) };
    const ssh = {
      connect: async (target: { id: string }) => ({
        // Российский проверяющий: первая попытка проходит целиком, две следующие — порт не отвечает.
        exec: async () => {
          if (target.id !== 'ru1') return { stdout: PORT, code: 0 };
          n += 1;
          return { stdout: n === 1 ? OK : DEAD, code: 0 };
        },
        end: () => undefined,
      }),
    };
    const svc = new NodeBlockCheckService(
      servers as never,
      ssh as never,
      {} as never,
      {} as never,
      {} as never,
      { status: async () => ({ configured: false, routes: null }) } as never,
    );
    const r = await svc.check('n', '1.2.3.4', 443, 'site.ru', 'exit', [
      srv('exit', 'DE'),
      srv('ru1', 'RU'),
      srv('nl', 'NL'),
    ]);
    expect(r.verdict).toBe('partial');
    expect(r.probes[0]).toMatchObject({
      verdict: 'partial',
      detail: 'Порт отвечает не каждый раз: подключение прошло в 1 из 3 попыток.',
    });
    expect(r.foreign).toHaveLength(1);
  });

  it('из России не отвечает никому, из-за рубежа отвечает — блокировка IP; не отвечает и там — недоступен', async () => {
    const blocked = setup({ ru1: DEAD, ru2: DEAD, ru3: DEAD, nl: PORT });
    expect((await blocked.svc.check('n', '1.2.3.4', 443, 'site.ru', 'exit', all)).verdict).toBe('ip_block');
    const dead = setup({ ru1: DEAD, ru2: DEAD, ru3: DEAD, nl: DEAD });
    const r = await dead.svc.check('n', '1.2.3.4', 443, 'site.ru', 'exit', all);
    expect(r.verdict).toBe('unreachable');
    expect(r.foreign).toHaveLength(1);
  });
});

describe('проверка входа: почему не состоялась', () => {
  const target = (over: Partial<UpstreamTarget> = {}): UpstreamTarget => ({
    label: 'Мост «Мост»',
    host: '5.5.5.5',
    port: 443,
    owner: null,
    serverId: 'bridge',
    rented: false,
    ...over,
  });

  it('единственный российский сервер — сам мост: проверять не с чего, и панель никуда не заходит', async () => {
    const { svc, calls } = setup({ bridge: PORT });
    const r = await svc.checkEntry(target(), 'exit', [srv('exit', 'DE'), srv('bridge', 'RU')]);
    expect(r).toMatchObject({ probes: [], unchecked: 'no_probers', rented: false });
    expect(calls).toEqual([]);
  });

  it('адрес входа записан не как адрес — отдельная причина', async () => {
    const { svc } = setup({ ru1: PORT });
    const r = await svc.checkEntry(
      target({ label: 'Вход арендодателя', host: 'entry_1.example.com', serverId: null, rented: true }),
      'exit',
      [srv('exit', 'DE'), srv('ru1', 'RU')],
    );
    expect(r).toMatchObject({ probes: [], unchecked: 'bad_address', rented: true });
  });

  it('проверяющие есть, но панель ни на один не зашла — так и записано; зашла хоть на один — вход проверен', async () => {
    const all = [srv('exit', 'DE'), srv('bridge', 'RU'), srv('ru1', 'RU'), srv('ru2', 'RU')];
    const none = setup({ ru1: 'ssh', ru2: 'ssh' });
    expect(await none.svc.checkEntry(target(), 'exit', all)).toMatchObject({ probes: [], unchecked: 'ssh' });
    const one = setup({ ru1: 'ssh', ru2: DEAD });
    const r = await one.svc.checkEntry(target(), 'exit', all);
    expect(r).toMatchObject({ verdict: 'unreachable', unchecked: null });
    expect(r.probes.map((p) => p.from)).toEqual(['ru2']);
    // Мост сам себя не проверяет.
    expect(one.calls).not.toContain('bridge');
  });
});

describe('проверка «из каждой страны»: почему никто не проверил', () => {
  it('проверяющих нет, панель ни на один не зашла, команда не ответила — три разные причины', async () => {
    const lonely = setup({});
    expect(await lonely.svc.countryReach('1.2.3.4', 22, 'exit', [srv('exit', 'DE')])).toEqual({
      results: [],
      blind: 'no_probers',
    });
    const all = [srv('exit', 'DE'), srv('ru1', 'RU'), srv('nl', 'NL')];
    // Серверы есть, а панель не зашла ни на один: «проверить не с чего» было бы неправдой.
    const cut = setup({ ru1: 'ssh', nl: 'ssh' });
    expect(await cut.svc.countryReach('1.2.3.4', 22, 'exit', all)).toEqual({ results: [], blind: 'ssh' });
    const mute = setup({ ru1: 'hang', nl: '' });
    expect((await mute.svc.countryReach('1.2.3.4', 22, 'exit', all)).blind).toBe('no_answer');
    // Кто-то дошёл — причины нет, а не ответивший на вход проверяющий в список не попадает.
    const some = setup({ ru1: 'ssh', nl: DEAD });
    expect(await some.svc.countryReach('1.2.3.4', 22, 'exit', all)).toEqual({
      results: [{ from: 'nl', country: 'NL', open: false }],
      blind: null,
    });
  });
});
