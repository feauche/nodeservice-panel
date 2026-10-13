import { describe, expect, it } from 'vitest';
import { formatScenarioHostName, scenarioConditionMatches, scenarioSchema } from './scenarios.js';

const base = {
  id: '11111111-1111-4111-8111-111111111111',
  name: 'Проверка',
  trigger: 'offline',
  actions: ['check_tcp'],
};
describe('Сценарии: совместимость, логика и имена Host', () => {
  it('прежнее единственное условие остаётся рабочим', () => {
    const rule = scenarioSchema.parse(base);
    expect(
      scenarioConditionMatches(rule, { offline: true, online_drop: false, tcp_unreachable: false }),
    ).toBe(true);
  });
  it.each(['all', 'any'] as const)('%s: вся таблица истинности двух условий', (mode) => {
    const rule = scenarioSchema.parse({
      ...base,
      conditions: ['offline', 'tcp_unreachable'],
      conditionMode: mode,
    });
    for (const offline of [false, true])
      for (const tcp of [false, true])
        expect(scenarioConditionMatches(rule, { offline, tcp_unreachable: tcp, online_drop: false })).toBe(
          mode === 'all' ? offline && tcp : offline || tcp,
        );
  });
  it('не принимает повторные условия и нулевое время', () => {
    expect(scenarioSchema.safeParse({ ...base, conditions: ['offline', 'offline'] }).success).toBe(false);
    expect(scenarioSchema.safeParse({ ...base, holdMinutes: 0 }).success).toBe(false);
  });
  it.each([
    ['🇩🇪 Нода', 'prepend', '🔴', '🇩🇪 🔴 Нода'],
    ['Нода', 'prepend', '🔴', ' 🔴 Нода'],
    ['🇩🇪 Нода', 'append', ' 🔴 ', '🇩🇪 Нода 🔴 '],
    ['🇩🇪 Нода', 'replace', 'Резерв', ' Резерв '],
    ['🏳️‍🌈 Нода', 'prepend', '⚠️', '🏳️‍🌈 ⚠️ Нода'],
    // Пометка уже стоит — второй раз не добавляется.
    ['🇩🇪 Нода 🔴 ', 'append', '🔴', '🇩🇪 Нода 🔴 '],
    ['🇩🇪 🔴 Нода', 'prepend', '🔴', '🇩🇪 🔴 Нода'],
    [' 🔴 Нода', 'prepend', '🔴', ' 🔴 Нода'],
  ] as const)('пробелы и флаг: %s %s', (name, mode, text, result) =>
    expect(formatScenarioHostName(name, mode, text)).toBe(result),
  );
});
