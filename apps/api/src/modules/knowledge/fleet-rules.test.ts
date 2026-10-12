import { describe, expect, it } from 'vitest';

import {
  FLEET_RULES_MAX,
  FLEET_RULES_TEMPLATE,
  FLEET_RULES_WHITELIST_SECTION,
  fleetRulesBlock,
  fleetRulesText,
} from './fleet-rules.js';

describe('fleetRulesText', () => {
  it('шаблон без записей владельца — пусто: в инструкцию ничего не добавляется', () => {
    expect(fleetRulesText(FLEET_RULES_TEMPLATE)).toBeNull();
    expect(fleetRulesText('')).toBeNull();
  });
  it('шаблон про ноды: есть раздел серверов белого списка, нет серверов, агента и обслуживания по SSH', () => {
    expect(FLEET_RULES_TEMPLATE).toContain(`## ${FLEET_RULES_WHITELIST_SECTION}\n`);
    expect(FLEET_RULES_TEMPLATE).toContain('## Критичные ноды\n');
    for (const old of ['Критичные серверы', 'Окна обслуживания', 'SSH', 'агент', 'перезагружать'])
      expect(FLEET_RULES_TEMPLATE, old).not.toContain(old);
  });
  it('остаются только записи владельца и заголовки разделов, где они есть; подсказки и вступление убраны', () => {
    const filled = FLEET_RULES_TEMPLATE.replace(
      '## Критичные ноды\n',
      '## Критичные ноды\n- msk-1: единственный вход для мобильных\n',
    )
      .replace(
        `## ${FLEET_RULES_WHITELIST_SECTION}\n`,
        `## ${FLEET_RULES_WHITELIST_SECTION}\n- spb-bs-1: МТС, Санкт-Петербург\n`,
      )
      .replace('## Принятые решения\n', '## Принятые решения\nПерезапуск нод только ночью по Москве.\n');
    const text = fleetRulesText(filled) ?? '';
    expect(text).toContain('## Критичные ноды\n- msk-1: единственный вход для мобильных');
    expect(text).toContain(`## ${FLEET_RULES_WHITELIST_SECTION}\n- spb-bs-1: МТС, Санкт-Петербург`);
    expect(text).toContain('## Принятые решения\nПерезапуск нод только ночью по Москве.');
    expect(text).not.toContain('## Окна работ');
    expect(text).not.toContain('Например');
    expect(text).not.toContain('Здесь владелец записывает');
    expect(text).not.toContain('# Правила парка');
  });
  it('старая статья с прежними разделами читается так же: разделы владельца не теряются', () => {
    const old = '# Правила парка\n\n## Критичные серверы\n- ru-entry-1: вход для LTE\n';
    expect(fleetRulesText(old)).toBe('## Критичные серверы\n- ru-entry-1: вход для LTE');
  });
  it('длинный текст обрезается и подсказывает, где полный', () => {
    const long = `## Нормы\n${'Очень важная строка правил. '.repeat(400)}`;
    const text = fleetRulesText(long) ?? '';
    expect(text.length).toBeLessThan(FLEET_RULES_MAX + 200);
    expect(text).toContain('текст обрезан');
    expect(text).toContain('search_kb');
  });
  it('блок для инструкции говорит, что правила не отменяют безопасность, и называет раздел БС', () => {
    const b = fleetRulesBlock('## Нормы\nCPU до 60 %.');
    expect(b).toContain('ПРАВИЛА ПАРКА');
    expect(b).toContain('не отменяют правил безопасности');
    expect(b).toContain(`«${FLEET_RULES_WHITELIST_SECTION}»`);
    expect(b).toContain('CPU до 60 %.');
  });
});
