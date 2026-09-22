import { describe, expect, it } from 'vitest';

import { HOME_SECTION, isSectionOpen, requireSectionOpen } from './stages';

describe('stages · поэтапное открытие разделов', () => {
  it('открыты Обзор, Серверы и Журнал; остальное под замком', () => {
    expect(isSectionOpen(HOME_SECTION)).toBe(true);
    expect(isSectionOpen('/servers')).toBe(true);
    expect(isSectionOpen('/audit')).toBe(true);
    for (const to of ['/incidents', '/settings', '/assistant', '/knowledge']) {
      expect(isSectionOpen(to)).toBe(false);
    }
  });

  it('requireSectionOpen: открытый раздел проходит, закрытый уводит на домашний', () => {
    expect(() => requireSectionOpen(HOME_SECTION)).not.toThrow();
    let thrown: unknown;
    try {
      requireSectionOpen('/incidents');
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeDefined();
    expect((thrown as { options?: { to?: string } }).options?.to).toBe(HOME_SECTION);
  });
});
