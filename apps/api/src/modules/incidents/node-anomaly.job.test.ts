import type { BlockCheckResult, RemnawaveNode } from '@nodeservice/shared';
import { describe, expect, it } from 'vitest';

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

const SOON: PaymentFacts = {
  overdue: [],
  dueSoon: [{ kind: 'rent', text: 'Аренда «Guardora»: 2 500 ₽, оплачено до 30 сентября, 16:00 (UTC+6)' }],
  paying: 1,
};

/**
 * Проверка онлайна на заглушках. `snap(node, error?)` кладёт очередной снимок Remnawave (у каждого своё
 * время) и прогоняет проход; в `opened` — заведённые дела.
 */
function setup(check: BlockCheckResult = result(), payment: PaymentFacts | null = SOON) {
  let seq = 0;
  let status: { connected: boolean; checkedAt: string; error: string | null; nodes: RemnawaveNode[] } = {
    connected: true,
    checkedAt: '',
    error: null,
    nodes: [],
  };
  const opened: Array<{ title: string; detail: string; kind: string; severity: string }> = [];
  /** У скольких других серверов сбой в те же полчаса (то же число, что видит детекция связи). */
  const trouble = { others: 0 };
  const job = new NodeAnomalyJob(
    { status: async () => status, nodeInbound: async () => ({ port: 443, sni: 'site.ru' }) } as never,
    {
      list: async () => [{ id: 's-1', name: 'guardora (Аренда)', host: '1.2.3.4', profile: { roles: [] } }],
    } as never,
    {
      list: async () => [],
      findOpen: async () => undefined,
      appendEvent: async () => undefined,
      update: async () => undefined,
      open: async (row: (typeof opened)[number]) => {
        opened.push(row);
        return { id: `i-${opened.length}`, ...row };
      },
    } as never,
    { check: async () => structuredClone(check), checkEntry: async () => null } as never,
    { push: async () => undefined } as never,
    {
      paymentWindowFor: async () => payment,
      analysisWillFollow: async () => false,
      fleetTrouble: async () => trouble.others,
    } as never,
  );
  const snap = async (n: RemnawaveNode, error: string | null = null) => {
    seq += 1;
    status = {
      connected: true,
      checkedAt: `2026-09-30T09:${String(seq).padStart(2, '0')}:00.000Z`,
      error,
      nodes: [n],
    };
    await job.run();
  };
  return { snap, opened, trouble };
}

describe('падение онлайна ноды', () => {
  it('три снимка подряд с просадкой — дело; при оплате в окне и недоступном сервере — «проверьте оплату»', async () => {
    const { snap, opened } = setup();
    await snap(node());
    for (let i = 0; i < 3; i += 1) await snap(node({ usersOnline: 0 }));
    expect(opened).toHaveLength(1);
    expect(opened[0]?.title).toBe('Сервер недоступен — проверьте оплату · guardora (Аренда)');
    expect(opened[0]?.detail).toContain('Вероятнее всего: оплата закончилась чуть раньше срока');
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

  it('сбой сразу у нескольких серверов — общая причина: «вероятнее всего… отключили» не пишем', async () => {
    const { snap, opened, trouble } = setup();
    // У другого сервера пять минут назад открылось «Сервер недоступен» (или замолчал агент).
    trouble.others = 1;
    await snap(node());
    for (let i = 0; i < 3; i += 1) await snap(node({ usersOnline: 0 }));
    expect(opened[0]?.title).toBe('Сервер недоступен · guardora (Аренда)');
    expect(opened[0]?.detail).toContain('Заодно проверьте оплату: срок оплаты этого сервера близко.');
    expect(opened[0]?.detail).not.toContain('Вероятнее всего');
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
