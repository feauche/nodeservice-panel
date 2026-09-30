import { describe, expect, it } from 'vitest';

import { baselineFromDetail, NodeBlockRecheckJob, recoverThreshold } from './node-block-recheck.job.js';

describe('перепроверка падения онлайна', () => {
  it('онлайн до падения берётся из дела', () => {
    expect(baselineFromDetail('Онлайн: 396 → 0 (−100 %) за 5 минут\n\nИз России:')).toBe(396);
    expect(baselineFromDetail('без онлайна')).toBeNull();
  });

  it('«в норме» — половина прежнего, но не меньше минимальной базы', () => {
    expect(recoverThreshold(396)).toBe(198);
    expect(recoverThreshold(12)).toBe(10);
    expect(recoverThreshold(null)).toBe(10);
  });

  /** Перепроверка на заглушках: открыто одно дело падения онлайна, `snap` кладёт снимок и прогоняет проход. */
  function setup(verdict: 'ok' | 'partial' = 'ok') {
    let seq = 0;
    let status = { connected: true, checkedAt: '', error: null as string | null, nodes: [] as unknown[] };
    const notes: string[] = [];
    const closed: string[] = [];
    const row = {
      id: 'i-1',
      kind: 'node_blocked',
      serverId: null,
      serverName: 'guardora (Аренда)',
      detail: 'Онлайн: 200 → 0 (−100 %) за 5 минут',
    };
    const job = new NodeBlockRecheckJob(
      {
        list: async () => (closed.length > 0 ? [] : [row]),
        appendEvent: async (_id: string, e: { action: string }) => {
          notes.push(e.action);
        },
      } as never,
      {
        autoResolveById: async (_id: string, reason: string) => {
          closed.push(reason);
        },
      } as never,
      { status: async () => status, nodeInbound: async () => ({ port: 443, sni: 'site.ru' }) } as never,
      { list: async () => [] } as never,
      {
        check: async () => ({
          probes: [{ from: 'Мост', verdict: 'ok', detail: '', stalledAtKb: null, error: null }],
          foreign: [],
          verdict,
        }),
      } as never,
    );
    const snap = async (online: number, error: string | null = null) => {
      seq += 1;
      status = {
        connected: true,
        checkedAt: `2026-09-30T09:${String(seq).padStart(2, '0')}:00.000Z`,
        error,
        nodes: [{ uuid: 'u-1', name: 'guardora (Аренда)', address: '1.2.3.4', usersOnline: online }],
      };
      await job.run();
    };
    return { snap, notes, closed };
  }

  it('три настоящие проверки в норме — дело закрывается само', async () => {
    const { snap, closed } = setup();
    for (let i = 0; i < 3; i += 1) await snap(190);
    expect(closed).toHaveLength(1);
    expect(closed[0]).toContain('Онлайн 3 проверки подряд в норме: 190 (до падения 200). Порт открыт.');
  });

  it('неудачный опрос Remnawave — не проверка: «три в норме» на прежних числах не набираются', async () => {
    const { snap, closed } = setup();
    await snap(190);
    // Remnawave не отвечает: в снимке новое время и старые числа.
    await snap(190, 'таймаут');
    await snap(190, 'таймаут');
    expect(closed).toEqual([]);
    await snap(190);
    expect(closed).toEqual([]);
    await snap(190);
    expect(closed).toHaveLength(1);
  });

  it('порт отвечает с перебоями — закрывает по онлайну и говорит об этом прямо', async () => {
    const { snap, closed } = setup('partial');
    for (let i = 0; i < 3; i += 1) await snap(190);
    expect(closed[0]).toContain(
      'Порт отвечает с перебоями, но пользователи подключаются — ориентируюсь на онлайн.',
    );
  });
});
