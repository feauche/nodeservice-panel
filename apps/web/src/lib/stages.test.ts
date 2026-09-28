import { describe, expect, it } from 'vitest';

import { HOME_SECTION, isSectionOpen, requireSectionOpen } from './stages';

describe('stages · поэтапное открытие разделов', () => {
  it('открыты все готовые разделы, включая все настройки; будущие — под замком', () => {
    for (const to of [
      HOME_SECTION,
      '/servers',
      '/incidents',
      '/audit',
      '/assistant',
      '/knowledge',
      '/settings',
      '/settings/assistant',
      '/settings/notifications',
      '/settings/appearance',
      '/settings/security',
      '/settings/autochecks',
      '/settings/incidents',
    ])
      expect(isSectionOpen(to), to).toBe(true);
    // Раздел будущего этапа (R7 «Утилиты») ещё не открыт.
    expect(isSectionOpen('/utilities')).toBe(false);
  });

  it('requireSectionOpen: открытый раздел проходит, закрытый уводит на домашний', () => {
    expect(() => requireSectionOpen(HOME_SECTION)).not.toThrow();
    expect(() => requireSectionOpen('/settings/security')).not.toThrow();
    let thrown: unknown;
    try {
      requireSectionOpen('/utilities');
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeDefined();
    expect((thrown as { options?: { to?: string } }).options?.to).toBe(HOME_SECTION);
  });
});
