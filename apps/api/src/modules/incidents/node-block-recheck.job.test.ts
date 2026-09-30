import { describe, expect, it } from 'vitest';

import { NodeLinkService } from '../remnawave/node-link.service.js';
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
      new NodeLinkService({ resolve: async () => [] }),
    );
    const snap = async (online: number | null, error: string | null = null, isDisabled = false) => {
      seq += 1;
      status = {
        connected: true,
        checkedAt: `2026-09-30T09:${String(seq).padStart(2, '0')}:00.000Z`,
        error,
        nodes: [
          { uuid: 'u-1', name: 'guardora (Аренда)', address: '1.2.3.4', usersOnline: online, isDisabled },
        ],
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

  it('ноду выключили в Remnawave вручную — дело закрывается с пояснением, а не висит вечно', async () => {
    const { snap, closed, notes } = setup();
    await snap(0);
    expect(closed).toEqual([]);
    // Выключенная нода онлайн не вернёт никогда: ждать «три проверки в норме» бессмысленно.
    await snap(null, null, true);
    expect(closed).toEqual([
      'Ноду выключили в Remnawave вручную — следить за её онлайном больше не нужно. Если выключили из-за этого сбоя, причина осталась неразобранной: дело можно открыть в списке решённых.',
    ]);
    expect(notes.at(-1)).toContain('Слежу за онлайном ноды');
  });

  it('порт отвечает с перебоями — закрывает по онлайну и говорит об этом прямо', async () => {
    const { snap, closed } = setup('partial');
    for (let i = 0; i < 3; i += 1) await snap(190);
    expect(closed[0]).toContain(
      'Порт отвечает с перебоями, но пользователи подключаются — ориентируюсь на онлайн.',
    );
  });
});
