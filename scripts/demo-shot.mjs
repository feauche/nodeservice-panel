/**
 * Скриншот демо (design/preview.html) для пиксельной сверки страниц панели с эталоном.
 * Запуск: node scripts/demo-shot.mjs [view] [outPng]  (view: overview|servers|…, по умолчанию overview)
 */
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const view = process.argv[2] ?? 'overview';
const out = resolve(process.argv[3] ?? join(root, 'docs', 'screenshots', `demo-${view}.png`));

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1400 }, deviceScaleFactor: 2 });
  await page.goto(`file://${join(root, 'design', 'preview.html')}`);
  await page.evaluate((v) => {
    const auth = document.getElementById('auth');
    if (auth) auth.style.display = 'none';
    // @ts-expect-error функция демо
    if (typeof switchView === 'function') switchView(v);
  }, view);
  await page.waitForTimeout(1200);
  await page.screenshot({ path: out });
  console.log('demo →', out);
} finally {
  await browser.close();
}
