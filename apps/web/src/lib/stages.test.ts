import { describe, expect, it } from 'vitest';

import { HOME_SECTION, isSectionOpen, requireSectionOpen } from './stages';

describe('stages · поэтапное открытие разделов', () => {
  it('открыты Обзор, Серверы, Инциденты, Журнал, Ассистент, База знаний и настройки ассистента; остальное под замком', () => {
    expect(isSectionOpen(HOME_SECTION)).toBe(true);
    expect(isSectionOpen('/servers')).toBe(true);
    expect(isSectionOpen('/incidents')).toBe(true);
    expect(isSectionOpen('/audit')).toBe(true);
    for (const to of ['/assistant', '/knowledge', '/settings', '/settings/assistant']) {
      expect(isSectionOpen(to), to).toBe(true);
    }
    for (const to of [
      '/settings/appearance',
      '/settings/security',
      '/settings/autochecks',
      '/settings/incidents',
    ]) {
      expect(isSectionOpen(to), to).toBe(false);
    }
  });

  it('requireSectionOpen: открытый раздел проходит, закрытый уводит на домашний', () => {
    expect(() => requireSectionOpen(HOME_SECTION)).not.toThrow();
    let thrown: unknown;
    try {
      requireSectionOpen('/settings/security');
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeDefined();
    expect((thrown as { options?: { to?: string } }).options?.to).toBe(HOME_SECTION);
  });
});
