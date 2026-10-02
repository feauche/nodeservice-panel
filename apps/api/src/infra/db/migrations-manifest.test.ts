import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

it('каждая SQL-миграция зарегистрирована в журнале Drizzle', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const migrations = join(here, '..', '..', '..', 'drizzle', 'migrations');
  const files = readdirSync(migrations)
    .filter((name) => name.endsWith('.sql'))
    .map((name) => name.slice(0, -4))
    .sort();
  const journal = JSON.parse(readFileSync(join(migrations, 'meta', '_journal.json'), 'utf8')) as {
    entries: Array<{ tag: string }>;
  };
  expect(journal.entries.map(({ tag }) => tag).sort()).toEqual(files);
});
