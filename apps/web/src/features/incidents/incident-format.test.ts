import type { Incident } from '@nodeservice/shared';
import { describe, expect, it } from 'vitest';

import { closedAtMs, humanSeconds, outcomeSentence, weekStats } from './incident-format';

const NOW = Date.parse('2026-09-25T12:00:00Z');
const iso = (minAgo: number) => new Date(NOW - minAgo * 60_000).toISOString();

const base = (over: Partial<Incident>): Incident => ({
  id: '7d9a2b1c-3e4f-4a5b-8c6d-9e0f1a2b3c4d',
  serverId: '7d9a2b1c-3e4f-4a5b-8c6d-9e0f1a2b3c4e',
  serverName: 'de-fra-01',
  kind: 'disk_high',
  severity: 'warn',
  status: 'resolved',
  title: 'Диск заполняется · de-fra-01',
  detail: '',
  openedAt: iso(60),
  resolvedAt: iso(10),
  resolvedBy: 'auto',
  timeline: [],
  attempts: [],
  proposal: null,
  snapshot: null,
  ...over,
});

const attempt = (status: 'helped' | 'not_helped', by: 'auto' | 'manual', level: 'T0' | 'T1' = 'T1') => ({
  id: crypto.randomUUID(),
  action: level === 'T0' ? 'disk_inspect' : 'free_disk',
  level,
  by,
  status,
  startedAt: iso(55),
  finishedAt: iso(54),
  steps: [],
  log: '',
});

describe('outcomeSentence', () => {
  it('не врёт «прошло само», если шаги починки пробовали и не помогли', () => {
    const inc = base({ attempts: [attempt('not_helped', 'manual')] });
    expect(outcomeSentence(inc, NOW)).toBe('Проблема ушла сама, шаги починки не помогли');
  });
  it('чистое «прошло само» — когда шагов не было', () => {
    expect(outcomeSentence(base({}), NOW)).toBe('Прошло само, починка не потребовалась');
  });
  it('после одного осмотра', () => {
    const inc = base({ attempts: [{ ...attempt('not_helped', 'auto', 'T0'), status: 'done' as never }] });
    expect(outcomeSentence(inc, NOW)).toBe('Проблема ушла сама после осмотра');
  });
});

describe('weekStats', () => {
  it('разделяет «починила панель», «по вашей команде», «прошли сами» и «закрыты вручную»', () => {
    const s = weekStats(
      [
        base({ attempts: [attempt('helped', 'auto')] }),
        base({ attempts: [attempt('helped', 'manual')] }),
        base({ attempts: [attempt('not_helped', 'manual')] }),
        base({ resolvedBy: 'manual' }),
        base({ status: 'open', resolvedAt: null, resolvedBy: null }),
      ],
      NOW,
    );
    expect(s).toMatchObject({ total: 5, auto: 1, waited: 1, self: 1, manual: 1, open: 1 });
  });
  it('время починки — медиана: один долгий инцидент не портит картину', () => {
    const fast = (m: number) =>
      base({ openedAt: iso(m + 1), resolvedAt: iso(m), attempts: [attempt('helped', 'auto')] });
    const slow = base({ openedAt: iso(60 * 30), resolvedAt: iso(0), attempts: [attempt('helped', 'auto')] });
    const s = weekStats([fast(10), fast(20), slow], NOW);
    expect(s.medianFixS).toBe(60);
  });
});

describe('closedAtMs и humanSeconds', () => {
  it('у решённого — время закрытия, у открытого — открытия', () => {
    expect(closedAtMs(base({}))).toBe(NOW - 10 * 60_000);
    expect(closedAtMs(base({ status: 'open', resolvedAt: null }))).toBe(NOW - 60 * 60_000);
  });
  it('читается по-человечески', () => {
    expect(humanSeconds(40)).toBe('40 с');
    expect(humanSeconds(360)).toBe('6 мин');
    expect(humanSeconds(33120)).toBe('9 ч 12 мин');
  });
});
