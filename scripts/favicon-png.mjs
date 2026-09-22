import { readFileSync } from 'node:fs';
import { chromium } from '@playwright/test';

const svg = readFileSync(process.argv[2], 'utf8');
const out = process.argv[3];
const browser = await chromium.launch();
for (const size of [32, 180, 512]) {
  const page = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
  await page.setContent(
    `<html><body style="margin:0;background:transparent">${svg.replace('width="64" height="64"', `width="${size}" height="${size}"`)}</body></html>`,
  );
  await page.screenshot({
    path: `${out}/icon-${size}.png`,
    omitBackground: true,
    clip: { x: 0, y: 0, width: size, height: size },
  });
  await page.close();
}
await browser.close();
console.log('png ok');
