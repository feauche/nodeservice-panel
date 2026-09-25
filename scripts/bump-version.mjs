#!/usr/bin/env node
// Поднять версию панели везде сразу: package.json (корень, api, web, shared) и SHARED_VERSION.
// Использование: node scripts/bump-version.mjs patch | minor | 0.11.0
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const files = [
  'package.json',
  'apps/api/package.json',
  'apps/web/package.json',
  'packages/shared/package.json',
];
const sharedIndex = join(root, 'packages/shared/src/index.ts');

const current = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
const arg = process.argv[2];
if (!arg) {
  console.error('Укажите: patch | minor | x.y.z');
  process.exit(1);
}
const [maj, min, pat] = current.split('.').map(Number);
const next = arg === 'patch' ? `${maj}.${min}.${pat + 1}` : arg === 'minor' ? `${maj}.${min + 1}.0` : arg;
if (!/^\d+\.\d+\.\d+$/.test(next)) {
  console.error(`Некорректная версия: ${next}`);
  process.exit(1);
}
for (const f of files) {
  const p = join(root, f);
  const src = readFileSync(p, 'utf8');
  writeFileSync(p, src.replace(/("version":\s*")[^"]+(")/, `$1${next}$2`));
}
const idx = readFileSync(sharedIndex, 'utf8');
writeFileSync(sharedIndex, idx.replace(/(SHARED_VERSION = ')[^']+(')/, `$1${next}$2`));
console.log(`${current} → ${next}`);
