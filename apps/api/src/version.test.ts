import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SHARED_VERSION } from '@nodeservice/shared';
import { describe, expect, it } from 'vitest';

/** Версия живёт в пяти местах; расхождение — значит, забыли `node scripts/bump-version.mjs`. */
describe('версия панели', () => {
  const root = join(__dirname, '..', '..', '..');
  const read = (rel: string): string =>
    (JSON.parse(readFileSync(join(root, rel), 'utf8')) as { version: string }).version;

  it('везде одна и та же', () => {
    for (const f of [
      'package.json',
      'apps/api/package.json',
      'apps/web/package.json',
      'packages/shared/package.json',
    ])
      expect(read(f), f).toBe(SHARED_VERSION);
  });

  it('вид x.y.z', () => {
    expect(SHARED_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
