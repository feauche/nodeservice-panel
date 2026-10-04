import type { BlockCheckResult, IncidentSnapshot, RemnawaveNode } from '@nodeservice/shared';
import { describe, expect, it } from 'vitest';

import { NodeLinkService } from '../remnawave/node-link.service.js';
import { NodeAnomalyJob } from './node-anomaly.job.js';
import type { PaymentFacts } from './payment-hint.js';

const node = (over: Partial<RemnawaveNode> = {}): RemnawaveNode =>
  ({
    uuid: 'u-1',
    name: 'guardora (Аренда)',
    address: '1.2.3.4',
    usersOnline: 200,
    isConnected: true,
    isDisabled: false,
    ...over,
  }) as RemnawaveNode;

const probe = (verdict: 'ok' | 'unreachable', from: string) => ({
  from,
  verdict,
  detail:
    verdict === 'ok' ? 'TLS-подключение и передача данных прошли без обрывов.' : 'Порт не отвечает совсем.',
  stalledAtKb: null,
  error: null,
});

const result = (over: Partial<BlockCheckResult> = {}): BlockCheckResult => ({
  nodeName: 'guardora (Аренда)',
  address: '1.2.3.4',
  sniUsed: 'site.ru',
  probes: [probe('unreachable', 'Мост')],
  foreign: [probe('unreachable', 'Германия - 1')],
  verdict: 'unreachable',
  unchecked: null,
  foreignUnchecked: null,
  entry: null,
  ...over,
});

/** Начало отсчёта снимков в тестах: 30 сентября 2026, 09:00 UTC. */
const T0 = Date.parse('2026-09-30T09:00:00.000Z');
/** Сохранённые измерения ноды u-1: значения по минутам, последнее — за `agoMin` минут до первого снимка. */
const savedOnline = (values: number[], agoMin: number) => [
  {
    labels: { node_uuid: 'u-1', node_name: 'guardora (Аренда)' },
    points: values.map(
      (v, i) => [(T0 + 60_000) / 1000 - (agoMin + values.length - 1 - i) * 60, v] as [number, number],
    ),
  },
];

const SOON: PaymentFacts = {
  overdue: [],
  dueSoon: [{ kind: 'rent', text: 'Аренда «Guardora»: 2 500 ₽, оплачено до 30 сентября, 16:00 (UTC+6)' }],
  paying: 1,
};

/**
 * Проверка онлайна на заглушках. `snap(node, error?)` кладёт очередной снимок Remnawave (у каждого своё
 * время) и прогоняет проход; в `opened` — заведённые дела.
 */
function setup(
  check: BlockCheckResult = result(),
  payment: PaymentFacts | null = SOON,
  /** Сохранённые измерения онлайна (то, что панель читает после запуска); null — хранилище не отвечает. */
  saved: Array<{ labels: Record<string, string>; points: Array<[number, number]> }> | null = [],
  /** Серверы панели (по умолчанию один, с тем же адресом, что у ноды) и во что разрешаются домены. */
  fleet: { servers?: Array<Record<string, unknown>>; dns?: Record<string, string[]> } = {},
) {
  let seq = 0;
  let status: { connected: boolean; checkedAt: string; error: string | null; nodes: RemnawaveNode[] } = {
    connected: true,
    checkedAt: '',
    error: null,
    nodes: [],
  };
  const opened: Array<{
    title: string;
    detail: string;
    kind: string;
    severity: string;
    serverId: string | null;
    serverName: string;
    snapshot?: IncidentSnapshot;
  }> = [];
  const pushed: Array<{ severity: string; telegram?: { event: string } }> = [];
  /** С какими исключёнными серверами запускалась проверка порта ноды и входа. */
  const checks: Array<{ excluded: string[] }> = [];
  const checkFailure = { value: false };
  const billingAsked: string[] = [];
  const srv = (over: Record<string, unknown>) => ({
    nodeLink: 'auto',
    facts: { addresses: [] },
    profile: { roles: [] },
    agentStatus: 'offline',
    ...over,
  });
  /** Открытые дела, которые «уже лежат в базе» (например, заведены до перезапуска панели). */
  const existing: Array<{
    id: string;
    serverId: string | null;
    serverName: string;
    kind: string;
    detail: string;
  }> = [];
  const events: Array<{ id: string; action: string }> = [];
  const vmCalls: string[] = [];
  /**
   * Что ещё сломалось в те же полчаса (то же, что видит детекция связи): у скольких других нод упал онлайн
   * и со сколькими другими серверами пропала связь.
   */
  const trouble = { nodes: 0, servers: 0 };
  const sshOpen = { value: false };
  /** Открытое «Сервер недоступен» у сервера ноды (его завела детекция связи). */
  const serverDown: { value: { id: string } | undefined } = { value: undefined };
  /** Что Remnawave отвечает о порте ноды; `failed` — запрос не прошёл. */
  const inbound: { value: { port: number | null; sni: string | null; failed?: boolean } } = {
    value: { port: 443, sni: 'site.ru' },
  };
  const job = new NodeAnomalyJob(
    { status: async () => status, nodeInbound: async () => inbound.value } as never,
    {
      list: async () =>
        (fleet.servers ?? [{ id: 's-1', name: 'guardora (Аренда)', host: '1.2.3.4' }]).map(srv),
    } as never,
    {
      list: async () => existing,
      findOpen: async (_id: string, kind: string) => (kind === 'server_down' ? serverDown.value : undefined),
      appendEvent: async (id: string, e: { action: string }) => {
        events.push({ id, action: e.action });
      },
      update: async () => undefined,
      open: async (row: (typeof opened)[number]) => {
        opened.push(row);
        return { id: `i-${opened.length}`, ...row };
      },
    } as never,
    {
      check: async (_n: string, _a: string, _p: number, _s: string, exclude: string[]) => {
        checks.push({ excluded: [...exclude].sort() });
        if (checkFailure.value) throw new Error('встречная проверка временно недоступна');
        return structuredClone(check);
      },
      checkEntry: async () => null,
    } as never,
    {
      push: async (message: { severity: string; telegram?: { event: string } }) => {
        pushed.push(message);
      },
    } as never,
    {
      paymentWindowFor: async (id: string) => {
        billingAsked.push(id);
        return payment;
      },
      analysisWillFollow: async () => false,
      fleetTrouble: async () => ({
        nodes: trouble.nodes,
        linkedNodes: trouble.nodes,
        servers: trouble.servers,
      }),
      // Порт SSH с панели: открыт — сервер работает, даже если агент молчит.
      probeHost: async () => sshOpen.value,
    } as never,
    {
      queryRange: async (q: string) => {
        vmCalls.push(q);
        return saved;
      },
    } as never,
    new NodeLinkService({ resolve: async (host) => fleet.dns?.[host] ?? [] }),
  );
  /** Очередной снимок: через минуту после прошлого или через `skipMin` минут (перерыв в снимках). */
  const snap = async (n: RemnawaveNode | RemnawaveNode[], error: string | null = null, skipMin = 1) => {
    seq += skipMin;
    status = {
      connected: true,
      checkedAt: new Date(T0 + seq * 60_000).toISOString(),
      error,
      nodes: Array.isArray(n) ? n : [n],
    };
    await job.run();
  };
  return {
    snap,
    opened,
    pushed,
    trouble,
    sshOpen,
    serverDown,
    inbound,
    existing,
    events,
    vmCalls,
    checks,
    checkFailure,
    billingAsked,
    job,
    rerun: () => job.run(),
  };
}

describe('падение онлайна ноды', () => {
  it('одновременная просадка двух нод создаёт одно массовое дело', async () => {
    const second = node({ uuid: 'u-2', name: 'нидерланды - 2', address: '5.6.7.8' });
    const { snap, opened } = setup(result(), SOON, [], {
      servers: [
        { id: '00000000-0000-4000-8000-000000000001', name: 'guardora (Аренда)', host: '1.2.3.4' },
        { id: '00000000-0000-4000-8000-000000000002', name: 'нидерланды - 2', host: '5.6.7.8' },
      ],
    });
    await snap([node(), second]);
    for (let i = 0; i < 3; i += 1) {
      await snap([node({ usersOnline: 0 }), { ...second, usersOnline: 0 }]);
    }

    expect(opened).toHaveLength(1);
    expect(opened[0]?.title).toBe('Массовое падение онлайна · 2 ноды');
    expect(opened[0]?.serverId).toBeNull();
    expect(opened[0]?.snapshot?.fleet?.members.map((member) => member.nodeUuid)).toEqual(['u-1', 'u-2']);
  });

  it('три снимка подряд с просадкой — дело; при оплате в окне и недоступном сервере — «проверьте оплату»', async () => {
    const { snap, opened } = setup();
    await snap(node());
    for (let i = 0; i < 3; i += 1) await snap(node({ usersOnline: 0 }));
    expect(opened).toHaveLength(1);
    expect(opened[0]?.title).toBe('Сервер недоступен — проверьте оплату · guardora (Аренда)');
    expect(opened[0]?.detail).toContain('Вероятнее всего: оплата закончилась чуть раньше срока');
  });

  it('падение ступеньками: ни один шаг не дотягивает до порога, а за пять минут онлайн упал на 90 %', async () => {
    const { snap, opened } = setup();
    // 300 → 200 (−33 %) → 110 (−45 %) → 30 (−73 %): сравнение с предыдущей минутой ничего не видело.
    for (const online of [300, 300, 200, 110]) await snap(node({ usersOnline: online }));
    for (let i = 0; i < 2; i += 1) await snap(node({ usersOnline: 30 }));
    expect(opened).toEqual([]);
    await snap(node({ usersOnline: 30 }));
    expect(opened).toHaveLength(1);
    expect(opened[0]?.detail).toContain('Онлайн: 300 → 30 (−90 %)');
  });

  it('в тексте — настоящее время между прежним онлайном и подтверждением, а не всегда «5 минут»', async () => {
    const { snap, opened } = setup();
    await snap(node({ usersOnline: 300 }));
    // Прежний онлайн — в 09:01, три снимка с просадкой — 09:02, 09:03, 09:04.
    for (let i = 0; i < 3; i += 1) await snap(node({ usersOnline: 0 }));
    expect(opened[0]?.detail).toContain('Онлайн: 300 → 0 (−100 %) за 3 минуты');
  });

  it('высокий онлайн был раньше окна — это уже не резкое падение', async () => {
    const { snap, opened } = setup();
    await snap(node({ usersOnline: 300 }));
    // Семь минут онлайн понемногу снижается; к свежему снимку 300 уже за пределами пяти минут.
    for (const online of [260, 220, 180, 150, 120, 100, 80]) await snap(node({ usersOnline: online }));
    for (let i = 0; i < 3; i += 1) await snap(node({ usersOnline: 50 }));
    expect(opened).toEqual([]);
  });

  it('постепенный обвал более 90 % не исчезает за пятиминутным окном', async () => {
    const { snap, opened } = setup();
    // Ни один отрезок в пять минут не падает на 80 %, но нода в итоге теряет 95 % онлайна.
    for (const online of [600, 600, 600, 500, 400, 320, 250, 200, 160, 125, 100, 80, 64])
      await snap(node({ usersOnline: online }));
    for (const online of [51, 47, 40, 35]) await snap(node({ usersOnline: online }));
    expect(opened).toEqual([]);
    await snap(node({ usersOnline: 29 }));
    expect(opened).toHaveLength(1);
    expect(opened[0]?.detail).toContain('Онлайн: 600 → 29 (−95 %)');
  });

  it('после перезапуска длительный обвал виден в сохранённых измерениях', async () => {
    const saved = savedOnline([600, 610, 590, 400, 300, 200, 140, 100, 70, 45, 30], 1);
    const { snap, opened } = setup(result(), SOON, saved);
    for (let i = 0; i < 4; i += 1) await snap(node({ usersOnline: 29 }));
    expect(opened).toEqual([]);
    await snap(node({ usersOnline: 29 }));
    expect(opened).toHaveLength(1);
    expect(opened[0]?.detail).toContain('Онлайн: 590 → 29 (−95 %)');
  });

  it('тот же снимок дважды — одна проверка: «три подряд» на нём не набираются', async () => {
    const { snap, opened, rerun } = setup();
    await snap(node());
    await snap(node({ usersOnline: 0 }));
    for (let i = 0; i < 5; i += 1) await rerun();
    expect(opened).toEqual([]);
  });

  it('панель перезапустили, пока онлайн падал: прежний онлайн берётся из сохранённых измерений', async () => {
    // До перезапуска онлайн был около 300; последнее измерение — за три минуты до первого снимка.
    const { snap, opened, vmCalls } = setup(result(), SOON, savedOnline([290, 300, 295, 298, 300], 3));
    await snap(node({ usersOnline: 20 }));
    await snap(node({ usersOnline: 22 }));
    expect(opened).toEqual([]);
    await snap(node({ usersOnline: 21 }));
    expect(opened).toHaveLength(1);
    expect(opened[0]?.detail).toContain('Онлайн: 300 → 21 (−93 %) за 5 минут');
    // Сохранённые измерения читаются один раз после запуска, а не каждую минуту.
    expect(vmCalls).toHaveLength(1);
  });

  it('после перезапуска онлайн на месте — дела нет', async () => {
    const { snap, opened } = setup(result(), SOON, savedOnline([290, 300, 295], 2));
    for (let i = 0; i < 4; i += 1) await snap(node({ usersOnline: 280 }));
    expect(opened).toEqual([]);
  });

  it('панель не работала дольше получаса — прежний онлайн уже не база, счёт начинается заново', async () => {
    const { snap, opened } = setup(result(), SOON, savedOnline([300, 300, 300], 31));
    for (let i = 0; i < 4; i += 1) await snap(node({ usersOnline: 20 }));
    expect(opened).toEqual([]);
  });

  it('хранилище измерений не ответило — панель пробует ещё и работает как раньше', async () => {
    const { snap, opened, vmCalls } = setup(result(), SOON, null);
    await snap(node());
    for (let i = 0; i < 3; i += 1) await snap(node({ usersOnline: 0 }));
    expect(opened).toHaveLength(1);
    // Не больше трёх попыток: дальше история уже набралась в памяти.
    expect(vmCalls).toHaveLength(3);
  });

  it('Remnawave молчала десять минут — базой остаётся онлайн до перерыва', async () => {
    const { snap, opened } = setup();
    await snap(node({ usersOnline: 300 }));
    await snap(node({ usersOnline: 20 }), null, 10);
    await snap(node({ usersOnline: 20 }));
    await snap(node({ usersOnline: 20 }));
    expect(opened).toHaveLength(1);
    expect(opened[0]?.detail).toContain('Онлайн: 300 → 20 (−93 %) за 12 минут');
  });

  it('по этой ноде уже открыто дело о падении онлайна — второе не заводится, в первое идёт отметка', async () => {
    // Нода без сервера в панели: база данных дубль не остановит (у таких дел нет сервера), а пауза на
    // повтор жила только в памяти и пропадала при перезапуске.
    const { snap, opened, existing, events } = setup(result({ address: '9.9.9.9' }));
    existing.push({
      id: 'old-1',
      serverId: null,
      serverName: 'нода без сервера',
      kind: 'node_blocked',
      detail: 'Онлайн: 300 → 20 (−93 %) за 5 минут\n\nИз России:\n• Мост — порт не отвечает',
    });
    const lone = (usersOnline: number) =>
      node({ uuid: 'u-9', name: 'нода без сервера', address: '9.9.9.9', usersOnline });
    await snap(lone(300));
    for (let i = 0; i < 3; i += 1) await snap(lone(10));
    expect(opened).toEqual([]);
    expect(events).toEqual([
      { id: 'old-1', action: 'Онлайн ноды снова резко упал: 300 → 10. Новое дело не завожу — слежу в этом.' },
    ]);
  });

  describe('связь ноды с её сервером', () => {
    const drop = async (snap: (n: RemnawaveNode) => Promise<void>, over: Partial<RemnawaveNode>) => {
      await snap(node({ ...over, usersOnline: 300 }));
      for (let i = 0; i < 3; i += 1) await snap(node({ ...over, usersOnline: 0 }));
    };

    it('случай владельца: сервер добавлен по домену, нода в Remnawave — по IP; дело идёт на сервер', async () => {
      const { snap, opened, checks, billingAsked } = setup(result(), SOON, [], {
        servers: [
          { id: 's-nl', name: 'Нидерланды - 1', host: 'nl1.example.com' },
          { id: 's-ru', name: 'Мост', host: '5.5.5.5' },
        ],
        dns: { 'nl1.example.com': ['201.34.145.175'] },
      });
      await drop(snap, { name: 'Нидерланды - 1', address: '201.34.145.175' });
      expect(opened).toHaveLength(1);
      expect(opened[0]).toMatchObject({ serverId: 's-nl', serverName: 'Нидерланды - 1' });
      // Оплату спросили у «Биллинга» — раньше для такой ноды панель её не смотрела вовсе.
      expect(billingAsked).toEqual(['s-nl']);
      // Сам сервер ноды в проверке не участвует.
      expect(checks).toEqual([{ excluded: ['s-nl'] }]);
      expect(opened[0]?.detail).not.toContain('в панели не найден');
    });

    it('нода выбрана в профиле сервера вручную — связь есть, хотя адреса разные', async () => {
      const { snap, opened } = setup(result(), SOON, [], {
        servers: [{ id: 's-nat', name: 'За NAT', host: '10.0.0.5', nodeLink: 'u-1' }],
      });
      await drop(snap, { name: 'nat-node', address: '7.7.7.7' });
      expect(opened[0]).toMatchObject({ serverId: 's-nat', serverName: 'За NAT' });
    });

    it('вторая запись той же машины в проверку не идёт: сервер не проверяет сам себя', async () => {
      const { snap, checks } = setup(result(), SOON, [], {
        servers: [
          { id: 's-a', name: 'Германия - 1', host: '3.3.3.3' },
          { id: 's-b', name: 'Германия - 1 (копия)', host: '3.3.3.3', nodeLink: 'none' },
        ],
      });
      await drop(snap, { name: 'de', address: '3.3.3.3' });
      expect(checks).toEqual([{ excluded: ['s-a', 's-b'] }]);
    });

    it('сервер ноды не найден — в деле об этом сказано прямо, и оплату панель не «проверяет»', async () => {
      const { snap, opened, billingAsked } = setup(result(), SOON, [], {
        servers: [{ id: 's-ru', name: 'Мост', host: '5.5.5.5' }],
      });
      await drop(snap, { name: 'чужая нода', address: '9.9.9.9' });
      expect(opened[0]).toMatchObject({ serverId: null, serverName: 'чужая нода' });
      expect(billingAsked).toEqual([]);
      expect(opened[0]?.detail).toContain(
        'Сервер этой ноды в панели не найден: её адрес в Remnawave — 9.9.9.9, он не совпал ни с одним сервером. Оплату, агента и вход этого сервера панель поэтому не проверяла.',
      );
      expect(opened[0]?.detail).toContain(
        'Если сервер добавлен под другим адресом — выберите эту ноду в его профиле («Нода Remnawave на сервере»).',
      );
    });

    it('сервер не найден, но есть сервер с тем же названием — подсказка, какой профиль открыть', async () => {
      const { snap, opened } = setup(result(), SOON, [], {
        servers: [{ id: 's-nl', name: 'Нидерланды - 1', host: '8.8.8.1' }],
      });
      await drop(snap, { name: 'Нидерланды - 1', address: '201.34.145.175' });
      expect(opened[0]).toMatchObject({ serverId: null });
      expect(opened[0]?.detail).toContain(
        'Похоже, это сервер «Нидерланды - 1»: название то же, а адрес другой. Выберите эту ноду в его профиле («Нода Remnawave на сервере») — и панель будет проверять их вместе.',
      );
    });
  });

  describe('находки четвёртой проверки 0.44.0', () => {
    const HOSTING_LATE: PaymentFacts = {
      overdue: [
        { kind: 'server', text: 'Сервер «DE-2» у Aéza: €4.51, оплачено до 29 сентября, 16:00 (UTC+6)' },
      ],
      dueSoon: [],
      paying: 1,
    };
    const fall = async (snap: (n: RemnawaveNode) => Promise<void>) => {
      await snap(node({ usersOnline: 200 }));
      for (let i = 0; i < 3; i += 1) await snap(node({ usersOnline: 0 }));
    };

    it('агент молчит, а порт SSH с панели открывается — сервер работает: не «Сервер недоступен» и не «отключили за неоплату»', async () => {
      // Остановился контейнер ноды: порт ноды закрыт отовсюду, но сам сервер жив. Раньше дело называлось
      // «Сервер недоступен — просрочена оплата», а через полминуты закрывалось словами «Сервер снова отвечает».
      const { snap, opened, sshOpen } = setup(result(), HOSTING_LATE);
      sshOpen.value = true;
      await fall(snap);
      expect(opened).toHaveLength(1);
      expect(opened[0]).toMatchObject({
        title: 'Резко упал онлайн, порт ноды не отвечает · guardora (Аренда)',
        kind: 'node_blocked',
      });
      expect(opened[0]?.detail).toContain(
        'Похоже: сервер работает (порт SSH с панели открывается), а порт ноды не отвечает ни из России, ни из-за рубежа — нода не слушает порт или его закрыл файрвол.',
      );
      for (const s of ['Вероятнее всего', 'отключили за неоплату', '💳', 'сервер выключен'])
        expect(opened[0]?.detail, s).not.toContain(s);
      // Порт SSH с панели тоже закрыт — сервер действительно недоступен, как и раньше.
      const down = setup(result(), HOSTING_LATE);
      await fall(down.snap);
      expect(down.opened[0]).toMatchObject({
        title: 'Сервер недоступен — просрочена оплата · guardora (Аренда)',
        kind: 'server_down',
      });
    });

    it('Remnawave не ответила на запрос порта ноды — причина так и названа, а не «порт не нашёлся»', async () => {
      const { snap, opened, inbound } = setup(result({ probes: [], foreign: [], unchecked: 'remnawave' }));
      inbound.value = { port: null, sni: null, failed: true };
      await fall(snap);
      expect(opened[0]?.detail).toContain(
        'Проверить не удалось: Remnawave не ответила на запрос порта этой ноды.',
      );
      expect(opened[0]?.detail).not.toContain('не нашёлся порт');
    });

    it('в профиле указан свой мост, а у моста нет ноды в Remnawave — вход записан непроверенным, без «другой причины панель не нашла»', async () => {
      const { snap, opened } = setup(
        result({ probes: [probe('ok', 'Мост')], foreign: [], verdict: 'ok' }),
        SOON,
        [],
        {
          servers: [
            {
              id: 's-1',
              name: 'guardora (Аренда)',
              host: '1.2.3.4',
              profile: {
                roles: ['exit'],
                upstream: { kind: 'bridge', serverId: 's-bridge', address: null, owner: null },
              },
            },
            { id: 's-bridge', name: 'Мост', host: '5.5.5.5' },
          ],
        },
      );
      await fall(snap);
      expect(opened).toHaveLength(1);
      expect(opened[0]?.title).toBe('Резко упал онлайн, вход проверить не удалось · guardora (Аренда)');
      expect(opened[0]?.detail).toContain(
        'Мост «Мост»: проверить нечем — у моста не найдена нода в Remnawave, и порт входа панель не знает.',
      );
      expect(opened[0]?.detail).toContain('Заодно проверьте оплату: срок аренды близко.');
      for (const s of ['Вероятнее всего', 'другой причины панель не нашла'])
        expect(opened[0]?.detail, s).not.toContain(s);
    });
  });

  it('ноду выключили в Remnawave вручную — это не сбой: дела нет, и после включения счёт начинается заново', async () => {
    const { snap, opened } = setup();
    await snap(node());
    for (let i = 0; i < 4; i += 1) await snap(node({ usersOnline: null, isDisabled: true }));
    expect(opened).toEqual([]);
    // Включили: онлайн растёт с нуля — сравнивать с прежними 200 нечего.
    await snap(node({ usersOnline: 0 }));
    for (let i = 0; i < 3; i += 1) await snap(node({ usersOnline: 3 }));
    expect(opened).toEqual([]);
  });

  it('выключили, когда просадка уже была замечена, — кандидат снят', async () => {
    const { snap, opened } = setup();
    await snap(node());
    await snap(node({ usersOnline: 0 }));
    await snap(node({ usersOnline: null, isDisabled: true }));
    await snap(node({ usersOnline: null, isDisabled: true }));
    expect(opened).toEqual([]);
  });

  it('неудачный опрос Remnawave — не новый снимок: «три подряд» на прежних числах не набираются', async () => {
    const { snap, opened } = setup();
    await snap(node());
    await snap(node({ usersOnline: 0 }));
    // Remnawave не отвечает: в снимке новое время и старые числа.
    await snap(node({ usersOnline: 0 }), 'таймаут');
    await snap(node({ usersOnline: 0 }), 'таймаут');
    expect(opened).toEqual([]);
    // Ответила — онлайн на месте: просадка была на один снимок, дела нет.
    await snap(node({ usersOnline: 190 }));
    await snap(node({ usersOnline: 195 }));
    expect(opened).toEqual([]);
  });

  it('после сбоя опроса просадка подтверждается настоящими снимками', async () => {
    const { snap, opened } = setup();
    await snap(node());
    await snap(node({ usersOnline: 0 }));
    await snap(node({ usersOnline: 0 }), 'таймаут');
    await snap(node({ usersOnline: 0 }));
    expect(opened).toEqual([]);
    await snap(node({ usersOnline: 0 }));
    expect(opened).toHaveLength(1);
  });

  it('ошибка диагностики не скрывает подтверждённое падение: открывается честное дело для Джарвиса', async () => {
    const { snap, opened, pushed, checkFailure } = setup();
    checkFailure.value = true;
    await snap(node({ usersOnline: 200 }));
    for (let i = 0; i < 3; i += 1) await snap(node({ usersOnline: 0 }));
    expect(opened).toHaveLength(1);
    expect(opened[0]).toMatchObject({
      title: 'Резко упал онлайн, причину проверить не удалось · guardora (Аренда)',
      kind: 'node_blocked',
      severity: 'crit',
    });
    expect(opened[0]?.detail).toContain('Падение подтверждено тремя свежими снимками Remnawave');
    expect(opened[0]?.detail).toContain('встречная проверка временно недоступна');
    expect(pushed[0]).toMatchObject({ severity: 'crit', telegram: { event: 'incident_crit' } });
  });

  it('полное падение онлайна критично, даже если порт отвечает и блокировка не подтвердилась', async () => {
    const { snap, opened, pushed } = setup(
      result({ verdict: 'ok', probes: [probe('ok', 'Мост')], foreign: [probe('ok', 'Германия - 1')] }),
      null,
    );
    await snap(node({ usersOnline: 473 }));
    for (let i = 0; i < 3; i += 1) await snap(node({ usersOnline: 0 }));

    expect(opened).toHaveLength(1);
    expect(opened[0]).toMatchObject({
      title: 'Резко упал онлайн, блокировка не подтвердилась · guardora (Аренда)',
      severity: 'crit',
    });
    expect(pushed[0]).toMatchObject({ severity: 'crit', telegram: { event: 'incident_crit' } });
  });

  it('сбой сразу у нескольких серверов — общая причина: «вероятнее всего… отключили» не пишем', async () => {
    const { snap, opened, trouble } = setup();
    // У другого сервера пять минут назад открылось «Сервер недоступен» (или замолчал агент).
    trouble.servers = 1;
    await snap(node());
    for (let i = 0; i < 3; i += 1) await snap(node({ usersOnline: 0 }));
    expect(opened[0]?.title).toBe('Сервер недоступен · guardora (Аренда)');
    expect(opened[0]?.detail).toContain('Заодно проверьте оплату: срок оплаты этого сервера близко.');
    expect(opened[0]?.detail).not.toContain('Вероятнее всего');
  });

  /** Аренда просрочена; нода отвечает — картина «сбой не у одного» просит проверить оплату «заодно». */
  const RENT_LATE: PaymentFacts = {
    overdue: [{ kind: 'rent', text: 'Аренда «Guardora»: 2 500 ₽, оплачено до 28 сентября' }],
    dueSoon: [],
    paying: 1,
  };
  const answers = () => result({ verdict: 'ok', probes: [probe('ok', 'Мост')], foreign: [] });
  /** Три снимка с просадкой подряд — падение подтверждено. */
  const drop = async (snap: (n: RemnawaveNode) => Promise<void>) => {
    await snap(node());
    for (let i = 0; i < 3; i += 1) await snap(node({ usersOnline: 0 }));
  };

  it('у других пропала связь, а онлайн не падал — так и написано: «онлайн упал у нескольких нод» панель не выдумывает', async () => {
    const { snap, opened, trouble } = setup(answers(), RENT_LATE);
    trouble.servers = 1;
    await drop(snap);
    expect(opened).toHaveLength(1);
    expect(opened[0]?.detail).toContain(
      'Заодно проверьте оплату: аренда просрочена. В это же время пропала связь с другими серверами — это больше похоже на общую причину.',
    );
    expect(opened[0]?.detail).not.toContain('Онлайн упал сразу у нескольких нод');
    expect(opened[0]?.detail).not.toContain('Вероятнее всего');
  });

  it('онлайн упал и у другой ноды — «Онлайн упал сразу у нескольких нод»', async () => {
    const { snap, opened, trouble } = setup(answers(), RENT_LATE);
    // И связь с третьим сервером пропала — но про онлайн панель знает точно, его и называет.
    trouble.nodes = 1;
    trouble.servers = 1;
    await drop(snap);
    expect(opened[0]?.detail).toContain(
      'Заодно проверьте оплату: аренда просрочена. Онлайн упал сразу у нескольких нод — это больше похоже на общую причину.',
    );
  });

  describe('у сервера ноды уже открыто «Сервер недоступен»', () => {
    it('порт SSH не открывается и с панели — падение онлайна дописано как следствие, порт ноды не проверяется', async () => {
      const { snap, opened, serverDown, events, checks } = setup();
      serverDown.value = { id: 'down-1' };
      await drop(snap);
      expect(opened).toEqual([]);
      expect(checks).toEqual([]);
      expect(events).toEqual([
        {
          id: 'down-1',
          action:
            'Онлайн ноды «guardora (Аренда)» упал с 200 до 0 — следствие недоступности сервера, проверку блокировки не запускаю.',
        },
      ]);
    });

    it('порт SSH с панели открывается — сервер включён: порт ноды проверен, итог записан в то же дело', async () => {
      const { snap, opened, serverDown, sshOpen, events, checks } = setup(
        result({
          verdict: 'tspu',
          probes: [
            {
              ...probe('ok', 'Мост'),
              verdict: 'tspu',
              detail: 'Подключение с именем маскировки обрывается.',
            },
          ],
          foreign: [],
        }),
      );
      serverDown.value = { id: 'down-1' };
      sshOpen.value = true;
      await drop(snap);
      // Второе дело не заводим: детекция связи всё равно слила бы его с «Сервер недоступен».
      expect(opened).toEqual([]);
      expect(checks).toHaveLength(1);
      expect(events).toEqual([
        {
          id: 'down-1',
          action:
            'Онлайн ноды «guardora (Аренда)» упал с 200 до 0. Сервер включён (порт SSH с панели открывается), поэтому порт ноды проверен. Похоже: региональная блокировка — настоящий VLESS/REALITY повторно не проходит из двух российских сетей, но работает из двух зарубежных стран.',
        },
      ]);
    });
  });

  it('порт отвечает с перебоями — отдельное дело без «Сервер недоступен» и без «вероятнее всего оплата»', async () => {
    const { snap, opened } = setup(
      result({
        probes: [probe('ok', 'Мост'), probe('unreachable', 'Россия - 1')],
        foreign: [],
        verdict: 'partial',
      }),
    );
    await snap(node());
    for (let i = 0; i < 3; i += 1) await snap(node({ usersOnline: 10 }));
    expect(opened).toHaveLength(1);
    expect(opened[0]).toMatchObject({
      title: 'Резко упал онлайн, порт отвечает с перебоями · guardora (Аренда)',
      kind: 'node_blocked',
      severity: 'crit',
    });
    expect(opened[0]?.detail).toContain(
      'Заодно проверьте оплату: срок аренды близко. Порт отвечает с перебоями',
    );
    expect(opened[0]?.detail).not.toContain('Вероятнее всего');
  });
});
