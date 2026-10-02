import { describe, expect, it } from 'vitest';

import { newerVersion, plainVersion, versionParts } from './panel-release.logic.js';

describe('версии панели', () => {
  it('принимает тег с v и строгую версию', () => {
    expect(versionParts('v0.55.0')).toEqual([0, 55, 0]);
    expect(plainVersion('1.2.3')).toBe('1.2.3');
    expect(plainVersion('v1.2')).toBeNull();
    expect(plainVersion('v1.2.3-beta')).toBeNull();
  });

  it('сравнивает числа, а не строки', () => {
    expect(newerVersion('0.9.9', 'v0.10.0')).toBe(true);
    expect(newerVersion('1.2.3', 'v1.2.4')).toBe(true);
    expect(newerVersion('1.2.3', 'v1.2.3')).toBe(false);
    expect(newerVersion('1.2.3', 'v1.1.99')).toBe(false);
  });
});
