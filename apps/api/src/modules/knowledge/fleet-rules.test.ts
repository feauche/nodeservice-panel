import { describe, expect, it } from 'vitest';

import { FLEET_RULES_MAX, FLEET_RULES_TEMPLATE, fleetRulesBlock, fleetRulesText } from './fleet-rules.js';

describe('fleetRulesText', () => {
  it('шаблон без записей владельца — пусто: в инструкцию ничего не добавляется', () => {
    expect(fleetRulesText(FLEET_RULES_TEMPLATE)).toBeNull();
    expect(fleetRulesText('')).toBeNull();
  });
  it('остаются только записи владельца и заголовки разделов, где они есть; подсказки и вступление убраны', () => {
    const filled = FLEET_RULES_TEMPLATE.replace(
      '## Критичные серверы\n',
      '## Критичные серверы\n- ru-entry-1: единственный вход для LTE\n',
    ).replace('## Принятые решения\n', '## Принятые решения\nПерезагрузки только ночью по Москве.\n');
    const text = fleetRulesText(filled) ?? '';
    expect(text).toContain('## Критичные серверы\n- ru-entry-1: единственный вход для LTE');
    expect(text).toContain('## Принятые решения\nПерезагрузки только ночью по Москве.');
    expect(text).not.toContain('## Окна обслуживания');
    expect(text).not.toContain('Например');
    expect(text).not.toContain('Здесь владелец записывает');
    expect(text).not.toContain('# Правила парка');
  });
  it('длинный текст обрезается и подсказывает, где полный', () => {
    const long = `## Нормы\n${'Очень важная строка правил. '.repeat(400)}`;
    const text = fleetRulesText(long) ?? '';
    expect(text.length).toBeLessThan(FLEET_RULES_MAX + 200);
    expect(text).toContain('текст обрезан');
    expect(text).toContain('search_kb');
  });
  it('блок для инструкции говорит, что правила не отменяют безопасность', () => {
    const b = fleetRulesBlock('## Нормы\nCPU до 60 %.');
    expect(b).toContain('ПРАВИЛА ПАРКА');
    expect(b).toContain('не отменяют правил безопасности');
    expect(b).toContain('CPU до 60 %.');
  });
});
