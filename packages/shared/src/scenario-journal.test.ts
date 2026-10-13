import { describe, expect, it } from 'vitest';
import { journalPage, scenarioJournalQuerySchema, scenarioOverview } from './scenario-journal.js';
import type { ScenarioRun } from './scenarios.js';

const NOW = Date.parse('2026-10-13T12:00:00Z');
const HOUR = 3_600_000;
const RULE = '22222222-2222-4222-8222-222222222222';
const OTHER = '33333333-3333-4333-8333-333333333333';
const NODE_A = '11111111-1111-4111-8111-111111111111';
const NODE_B = '44444444-4444-4444-8444-444444444444';

/** Срабатывание: часов назад, итог шагов (ok — всё выполнено, warn — замечание, crit — шаг не вышел). */
function run(
  id: string,
  hoursAgo: number,
  over: Partial<ScenarioRun> & { outcome?: 'ok' | 'warn' | 'crit' } = {},
) {
  const { outcome = 'ok', ...rest } = over;
  return {
    id,
    ruleId: RULE,
    ruleName: 'Критическое падение онлайна',
    t: NOW - hoursAgo * HOUR,
    nodeUuid: NODE_A,
    nodeName: 'Германия - 1',
    kind: 'run',
    title: 'Сработал: нода потеряла связь, 1 мин',
    steps: [
      outcome === 'crit'
        ? { text: 'нет права', tone: 'crit', failed: true, action: 'rename_host', n: 3 }
        : outcome === 'warn'
          ? { text: 'Уведомление в Telegram не отправлено', tone: 'warn', action: 'notify', n: 4 }
          : { text: 'Записано в событие', tone: 'info', action: 'record_event', n: 2 },
    ],
    failed: outcome === 'crit',
    ...rest,
  } as ScenarioRun;
}
const q = (input: Record<string, string> = {}) => scenarioJournalQuerySchema.parse(input);

describe('журнал срабатываний порциями', () => {
  const runs = [
    run('a', 1),
    run('b', 2, { outcome: 'warn', nodeUuid: NODE_B, nodeName: 'Нидерланды - 1' }),
    run('c', 3, { outcome: 'crit' }),
    run('d', 30),
    run('e', 24 * 8),
    run('x', 2, { ruleId: OTHER, ruleName: 'Другой' }),
    // Возврат Host после срабатывания «a» — внутри него, а не отдельной записью.
    {
      ...run('back-a', 0.5),
      kind: 'restore',
      title: 'Host вернули',
      steps: [{ text: 'Host вернули', tone: 'ok' }],
    },
  ] as ScenarioRun[];

  it('внутри сценария: свои срабатывания, возврат Host — внутри своего, числа по итогам за период', () => {
    const page = journalPage(runs, q({ rule: RULE, period: '7d' }), NOW);
    expect(page.items.map((e) => e.run.id)).toEqual(['a', 'b', 'c', 'd']);
    expect(page.items[0]?.backs.map((b) => b.id)).toEqual(['back-a']);
    expect(page.items.map((e) => e.tone)).toEqual(['ok', 'warn', 'crit', 'ok']);
    expect(page.counts).toEqual({ all: 4, ok: 2, warn: 1, crit: 1, teal: 0 });
    expect(page.total).toBe(4);
    expect(page.next).toBeNull();
    expect(page.retentionDays).toBe(30);
    // Полоска — последние срабатывания сценария без отборов периода и ноды.
    expect(page.strip.map((s) => s.tone)).toEqual(['ok', 'warn', 'crit', 'ok', 'ok']);
  });

  it('отбор по итогам не меняет числа на кнопках; отбор по ноде и периоду — меняет', () => {
    const warn = journalPage(runs, q({ rule: RULE, period: '7d', tone: 'warn,crit' }), NOW);
    expect(warn.items.map((e) => e.run.id)).toEqual(['b', 'c']);
    expect(warn.counts.all).toBe(4);
    expect(warn.total).toBe(2);
    const node = journalPage(runs, q({ rule: RULE, node: NODE_B }), NOW);
    expect(node.items.map((e) => e.run.id)).toEqual(['b']);
    const day = journalPage(runs, q({ rule: RULE, period: '24h' }), NOW);
    expect(day.items.map((e) => e.run.id)).toEqual(['a', 'b', 'c']);
  });

  it('порции по курсору: новые срабатывания сверху не сдвигают продолжение; одно время у двух нод — без потерь', () => {
    const same = [
      run('p1', 1),
      run('p2', 1, { nodeUuid: NODE_B }),
      run('p3', 1),
      run('p4', 2),
      run('p5', 3),
    ] as ScenarioRun[];
    const first = journalPage(same, q({ rule: RULE, limit: '2' }), NOW);
    expect(first.items).toHaveLength(2);
    expect(first.next).not.toBeNull();
    const fresh = [run('new', 0.1), ...same];
    const second = journalPage(fresh, q({ rule: RULE, limit: '2', before: first.next ?? '' }), NOW);
    const third = journalPage(fresh, q({ rule: RULE, limit: '2', before: second.next ?? '' }), NOW);
    const seen = [...first.items, ...second.items, ...third.items].map((e) => e.run.id);
    expect(new Set(seen).size).toBe(5);
    expect(seen.sort()).toEqual(['p1', 'p2', 'p3', 'p4', 'p5']);
    expect(third.next).toBeNull();
  });

  it('без сценария — журнал всех; лишние итоги в запросе отбрасываются', () => {
    const all = journalPage(runs, q({ tone: 'ok,чужое' }), NOW);
    // Период по умолчанию — все 30 дней: срабатывание недельной давности тоже здесь.
    expect(all.items.map((e) => e.run.id)).toEqual(['a', 'x', 'd', 'e']);
    expect(scenarioJournalQuerySchema.safeParse({ before: '1; drop' }).success).toBe(false);
    expect(scenarioJournalQuerySchema.safeParse({ limit: '500' }).success).toBe(false);
  });
});

describe('сводка для списка сценариев', () => {
  it('по сценарию — последнее срабатывание, числа за сутки и неделю, полоска; сверху — включено, сутки по 2 часа, неделя', () => {
    const rules = [
      { id: RULE, enabled: true, autoRestore: true },
      { id: OTHER, enabled: false, autoRestore: true },
    ];
    const runs = [
      run('a', 1),
      run('b', 3, { outcome: 'warn' }),
      run('c', 30, { outcome: 'crit' }),
      run('d', 24 * 10),
    ] as ScenarioRun[];
    const o = scenarioOverview(rules, runs, 2, NOW);
    expect(o.tiles).toMatchObject({
      enabled: 1,
      total: 2,
      day: 2,
      week: 3,
      weekWarn: 1,
      weekCrit: 1,
      marked: 2,
    });
    // Последние два промежутка по 2 часа: «b» (3 часа назад) — замечание, «a» (час назад) — выполнено.
    expect(o.tiles.daySlots.slice(-2)).toEqual(['warn', 'ok']);
    expect(o.tiles.daySlots.filter(Boolean)).toHaveLength(2);
    expect(o.items[0]).toMatchObject({ ruleId: RULE, day: 2, dayWarn: 1, week: 3 });
    expect(o.items[0]?.last).toMatchObject({ nodeName: 'Германия - 1', tone: 'ok' });
    expect(o.items[0]?.strip.map((s) => s.tone)).toEqual(['ok', 'warn', 'crit', 'ok']);
    expect(o.items[0]).toMatchObject({ weekWarn: 1, weekCrit: 1 });
    expect(o.items[1]).toEqual({
      ruleId: OTHER,
      last: null,
      day: 0,
      dayWarn: 0,
      week: 0,
      weekWarn: 0,
      weekCrit: 0,
      strip: [],
    });
  });
});
