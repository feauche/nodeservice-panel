import { describe, expect, it } from 'vitest';

import { HOME_SECTION, isSectionOpen, requireSectionOpen } from './stages';

describe('stages · поэтапное открытие разделов', () => {
  it('открыт только домашний раздел', () => {
    expect(isSectionOpen(HOME_SECTION)).toBe(true);
    for (const to of ['/', '/incidents', '/settings', '/assistant', '/knowledge', '/audit']) {
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
