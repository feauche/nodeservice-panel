/**
 * После сборки: каждый модуль dist загружается как ESM. Тесты (vitest) импорт из CommonJS-пакетов прощают,
 * а собранная панель — нет: `import { utils } from 'ssh2'` уронил api при запуске (0.39.1). Здесь такая ошибка
 * ломает сборку, и `nodeservice update` оставляет работать прежнюю версию.
 */
import { readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

process.env.NODE_ENV ??= 'test';
const root = resolve(import.meta.dirname, '../dist');
const files = [];
const walk = (d) => {
  for (const n of readdirSync(d)) {
    const f = join(d, n);
    if (statSync(f).isDirectory()) walk(f);
    else if (f.endsWith('.js') && !f.endsWith('.test.js') && !f.endsWith(`${'/'}main.js`)) files.push(f);
  }
};
walk(root);
const bad = [];
for (const f of files) {
  try {
    await import(f);
  } catch (e) {
    // Ошибки связывания модулей — всегда баг сборки; прочие (нет окружения) здесь не важны.
    if (e instanceof SyntaxError || /does not provide an export/.test(String(e)))
      bad.push(`${f.slice(root.length)}: ${e.message}`);
  }
}
if (bad.length) {
  console.error(`Модули не загружаются (${bad.length}):\n${bad.join('\n')}`);
  process.exit(1);
}
console.log(`Проверка импортов: ${files.length} модулей загружаются.`);
process.exit(0);
