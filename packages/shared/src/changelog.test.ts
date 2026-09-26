import { describe, expect, it } from 'vitest';

import { CHANGELOG } from './changelog.js';
import { SHARED_VERSION } from './index.js';

const parts = (v: string): number[] => v.split('.').map(Number);

describe('история версий', () => {
  it('первая запись — текущая версия: поднял версию, добавь запись в changelog.ts', () => {
    expect(CHANGELOG[0]?.version, 'Нет записи в packages/shared/src/changelog.ts для текущей версии').toBe(
      SHARED_VERSION,
    );
  });
  it('версии идут по убыванию, без повторов, у каждой есть дата и пункты', () => {
    for (let i = 1; i < CHANGELOG.length; i += 1) {
      const a = parts((CHANGELOG[i - 1] as { version: string }).version);
      const b = parts((CHANGELOG[i] as { version: string }).version);
      const newer = a[0]! !== b[0]! ? a[0]! > b[0]! : a[1]! !== b[1]! ? a[1]! > b[1]! : a[2]! > b[2]!;
      expect(newer, `${CHANGELOG[i - 1]?.version} должна быть новее ${CHANGELOG[i]?.version}`).toBe(true);
    }
    for (const e of CHANGELOG) {
      expect(e.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(e.items.length, e.version).toBeGreaterThan(0);
      for (const it of e.items) expect(it.trim().length, `${e.version}: пункт`).toBeGreaterThan(10);
    }
  });
});
