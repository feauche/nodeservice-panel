#!/usr/bin/env node
/**
 * Визуальная проверка этапа 1: проходит первый запуск → вход → 2FA → блокировку → каркас
 * против ЖИВОГО API (на отдельной БД nodeservice_shots и Valkey db 13) и снимает скриншоты
 * всех экранов в трёх темах. Запуск из panel/:  node scripts/screenshots.mjs [outDir]
 * Требует: dev-стек (docker compose -f infra/compose.dev.yaml up -d), pnpm build в apps/api и apps/web.
 */
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { chromium } from '@playwright/test';

const ROOT = resolve(import.meta.dirname, '..');
const API_DIR = join(ROOT, 'apps/api');
const WEB_DIR = join(ROOT, 'apps/web');
const OUT = resolve(process.argv[2] ?? join(ROOT, 'docs/screenshots'));
const API_PORT = 3200;
const WEB_PORT = 5200;
const DB_NAME = 'nodeservice_shots';
const ADMIN_DB = 'postgres://nodeservice:nodeservice@127.0.0.1:5432/postgres';
const DB_URL = `postgres://nodeservice:nodeservice@127.0.0.1:5432/${DB_NAME}`;
const apiRequire = createRequire(join(API_DIR, 'package.json'));
const { generate } = apiRequire('otplib');
const pg = apiRequire('pg');

mkdirSync(OUT, { recursive: true });
const log = (...a) => console.log('[shots]', ...a);

async function freshDb() {
  const c = new pg.Client({ connectionString: ADMIN_DB });
  await c.connect();
  await c.query(`DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE)`);
  await c.query(`CREATE DATABASE ${DB_NAME}`);
  await c.end();
}

function run(cmd, args, cwd, env, name) {
  const p = spawn(cmd, args, { cwd, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  p.out = '';
  p.stdout.on('data', (d) => {
    p.out += d;
  });
  p.stderr.on('data', (d) => {
    p.out += d;
  });
  p.on('exit', (code) => log(`${name} exited ${code}`));
  return p;
}

async function waitFor(url, ms = 60_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      const r = await fetch(url);
      if (r.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`timeout waiting ${url}`);
}

async function main() {
  await freshDb();
  const apiEnv = {
    NODE_ENV: 'development',
    PORT: String(API_PORT),
    DATABASE_URL: DB_URL,
    VALKEY_URL: 'redis://127.0.0.1:6379/13',
    PUBLIC_URL: `http://localhost:${WEB_PORT}`,
    LOG_LEVEL: 'warn',
    TRUST_PROXY: '0',
    APP_SECRET: 'screenshots-secret-0123456789abcdef0123456789',
    ENCRYPTION_KEY: '11'.repeat(32),
  };
  globalThis.__procs = {};
  const api = run('node', ['dist/main.js'], API_DIR, apiEnv, 'api');
  await waitFor(`http://127.0.0.1:${API_PORT}/api/health/ready`);
  // Токен первого запуска — через Rescue CLI (тот же код, что и в проде: docker exec … cli setup-token)
  const cliOut = await new Promise((resolveOut, reject) => {
    const c = spawn('node', ['dist/cli.js', 'setup-token'], {
      cwd: API_DIR,
      env: { ...process.env, ...apiEnv },
    });
    let out = '';
    c.stdout.on('data', (d) => {
      out += d;
    });
    c.stderr.on('data', (d) => {
      out += d;
    });
    c.on('exit', (code) => (code === 0 ? resolveOut(out) : reject(new Error(`cli exited ${code}:\n${out}`))));
  });
  const m = cliOut.match(/\n\s+([A-Za-z0-9_-]{40,})\s*\n/);
  const token = m?.[1];
  if (!token) throw new Error(`setup token not found in cli output:\n${cliOut}`);
  log('setup token found');

  const web = run(
    'pnpm',
    ['exec', 'vite', '--port', String(WEB_PORT), '--strictPort'],
    WEB_DIR,
    { VITE_API_TARGET: `http://127.0.0.1:${API_PORT}` },
    'web',
  );
  globalThis.__procs = { api, web };
  await waitFor(`http://127.0.0.1:${WEB_PORT}/login`);

  const browser = await chromium.launch();
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
    locale: 'ru-RU',
  });
  const page = await ctx.newPage();
  globalThis.__page = page;
  page.on('pageerror', (e) => log('PAGE ERROR:', e.message));
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') log(`console.${m.type()}:`, m.text().slice(0, 300));
  });
  const apiLog = [];
  globalThis.__apiLog = apiLog;
  page.on('response', async (r) => {
    if (r.url().includes('/api/auth/') && r.request().method() !== 'GET')
      apiLog.push(
        `${r.request().method()} ${r.url().replace(/^.*\/api/, '/api')} ${r.status()} ${(await r.text().catch(() => '')).slice(0, 160)}`,
      );
  });
  const base = `http://127.0.0.1:${WEB_PORT}`;
  const shot = async (name) => {
    await page.waitForTimeout(400);
    await page.screenshot({ path: join(OUT, `${name}.png`), fullPage: false });
    log('shot', name);
  };
  const setTheme = async (t) => {
    await page.evaluate((k) => {
      localStorage.setItem('ns-theme', k);
      document.documentElement.setAttribute('data-ns-theme', k);
    }, t);
    await page.waitForTimeout(150);
  };

  // --- первый запуск ---
  await page.goto(`${base}/setup`);
  await page.waitForSelector('input');
  await shot('01-setup-step1');
  const inputs = page.locator('input');
  const n = await inputs.count();
  // порядок: токен, логин, пароль, повтор
  await inputs.nth(0).fill(token);
  await inputs.nth(1).fill('admin');
  await inputs.nth(2).fill('correct horse battery staple');
  await inputs.nth(n - 1).fill('correct horse battery staple');
  await shot('02-setup-step1-filled');
  await page.getByRole('button', { name: /Далее/ }).click();
  await page
    .waitForSelector('img, svg[aria-label*="QR"], [data-testid=qr]', { timeout: 15_000 })
    .catch(() => {});
  await page.waitForTimeout(500);
  await shot('03-setup-step2-qr');
  const secretText = await page.evaluate(() => {
    const el = [...document.querySelectorAll('*')].find(
      (e) => /^[A-Z2-7 ]{16,}$/.test((e.textContent ?? '').trim()) && e.children.length === 0,
    );
    return el ? el.textContent.trim().replace(/\s+/g, '') : null;
  });
  if (!secretText) throw new Error('TOTP secret not found on step 2');
  const code = await generate({ secret: secretText });
  const otp = page.locator('input[autocomplete="one-time-code"], input[inputmode="numeric"]').first();
  await otp.click();
  await page.keyboard.type(code, { delay: 30 });
  await page.waitForTimeout(800);
  const confirmBtn = page.getByRole('button', { name: /Подтвердить/ });
  if (await confirmBtn.isVisible().catch(() => false)) await confirmBtn.click().catch(() => {});
  await page.waitForSelector('text=/Коды восстановления/', { timeout: 15_000 });
  await shot('04-setup-step3-codes');
  await page.getByRole('checkbox').first().click();
  await page.getByRole('button', { name: /Завершить/ }).click();
  await page.waitForURL(`${base}/`, { timeout: 15_000 });
  await page.waitForTimeout(600);
  await shot('05-app-shell-overview');

  // меню аккаунта + блокировка
  await page
    .getByRole('button', { name: /Учётная запись|LX|Аккаунт/i })
    .first()
    .click();
  await shot('06-user-menu');
  await page.getByRole('menuitem', { name: /Заблокировать/ }).click();
  await page.waitForURL(/\/lock/);
  await shot('07-lock');
  await page.locator('input[type=password]').fill('correct horse battery staple');
  await page.getByRole('button', { name: /Разблокировать/ }).click();
  await page.waitForURL(`${base}/`);

  // выход → вход в трёх темах
  await page
    .getByRole('button', { name: /Учётная запись|LX|Аккаунт/i })
    .first()
    .click();
  await page.getByRole('menuitem', { name: /Выйти/ }).click();
  await page.getByRole('button', { name: /Да, выйти/ }).click(); // подтверждение выхода
  await page.waitForURL(/\/login/);
  for (const t of ['dark', 'light', 'black']) {
    await setTheme(t);
    await page.reload();
    await page.waitForSelector('input');
    await shot(`08-login-${t}`);
  }
  await setTheme('dark');
  await page.reload();
  await page.waitForSelector('input');
  // ошибка пароля
  await page.locator('input').nth(0).fill('admin');
  await page.locator('input[type=password]').fill('wrong');
  await page.getByRole('button', { name: /Войти/ }).click();
  await page.waitForSelector('[role=alert]', { timeout: 10_000 });
  await shot('09-login-error');
  // верный пароль → 2FA
  await page.locator('input[type=password]').fill('correct horse battery staple');
  await page.getByRole('button', { name: /Войти/ }).click();
  await page.waitForURL(/\/login\/2fa/, { timeout: 15_000 });
  await shot('10-2fa');
  for (const t of ['light', 'black']) {
    await setTheme(t);
    await shot(`10-2fa-${t}`);
  }
  await setTheme('dark');
  // --- «Не спрашивать код 30 дней»: ставим галочку, входим, выходим, входим снова — 2FA не должна спрашиваться
  // Anti-replay на сервере: код из того же 30-секундного окна, что и при setup, отклоняется — ждём новое окно.
  let code2 = await generate({ secret: secretText });
  while (code2 === code) {
    await new Promise((r) => setTimeout(r, 1000));
    code2 = await generate({ secret: secretText });
  }
  await page.getByRole('checkbox').first().click();
  await page.locator('input[autocomplete="one-time-code"], input[inputmode="numeric"]').first().click();
  await page.keyboard.type(code2, { delay: 30 });
  await page.waitForURL(`${base}/`, { timeout: 15_000 });
  log('trusted device: logged in with rememberDevice');
  // выход через API (без UI, чтобы не зависеть от меню)
  await page.evaluate(async () => {
    const t = await (await fetch('/api/auth/csrf', { credentials: 'include' })).json();
    await fetch('/api/auth/logout', {
      method: 'POST',
      credentials: 'include',
      headers: { 'x-csrf-token': t.token },
    });
  });
  await page.goto(`${base}/login`);
  await page.waitForSelector('input');
  await page.locator('input').nth(0).fill('admin');
  await page.locator('input[type=password]').fill('correct horse battery staple');
  await page.getByRole('button', { name: /Войти/ }).click();
  await page.waitForURL(`${base}/`, { timeout: 15_000 });
  const url = page.url();
  if (!url.endsWith('/')) throw new Error('trusted device did NOT skip 2FA: ' + url);
  log('trusted device: second login skipped 2FA ✔');
  for (const t of ['light', 'black']) {
    await setTheme(t);
    await shot(`11-app-shell-${t}`);
  }

  // Настройки → Внешний вид: темы слева, логотип и название справа
  await setTheme('dark');
  await page.goto(`${base}/settings/appearance`);
  await page.waitForSelector('#brand-name');
  await shot('12-settings-appearance');
  await page.locator('#brand-logo').fill('https://i.postimg.cc/Nj8FjYW6/Lumax.png');
  await page.locator('#brand-name').fill('[#ff6b6b]Lumax [#accent]VPN');
  await page.getByRole('button', { name: 'Сохранить' }).click();
  await page.waitForSelector('text=Логотип и название сохранены');
  await page.waitForFunction(() => {
    const img = document.querySelector('img[alt="Логотип"]');
    return img instanceof HTMLImageElement && img.complete && img.naturalWidth > 0;
  });
  await page.waitForTimeout(300);
  await shot('13-settings-brand-custom');
  await page.getByRole('button', { name: 'Вернуть стандартные' }).click();
  await page.waitForSelector('text=Вернул стандартный');
  log('brand: custom logo + coloured name saved and reset ✔');

  // Серверы: пустое состояние (реальный SSH в этом сценарии не поднимаем)
  await page.goto(`${base}/servers`);
  await page.waitForSelector('text=Серверов пока нет');
  await shot('19-servers-empty');

  // Безопасность: пароль, 2FA, коды, сессии, устройства, политика
  await page.goto(`${base}/settings/security`);
  await page.waitForSelector('text=включена');
  await page.waitForSelector('text=текущая');
  await shot('16-settings-security');
  await page.getByRole('button', { name: 'Показать', exact: true }).click();
  await page.waitForSelector('[data-testid="recovery-codes"]');
  await shot('17-security-recovery-codes');
  await page.getByRole('button', { name: 'Закрыть' }).click();
  await page.getByRole('button', { name: 'Перевыпустить' }).click();
  await page.waitForSelector('img[alt^="QR"]');
  await shot('18-security-totp-reissue');
  await page.keyboard.press('Escape');
  await page.waitForSelector('img[alt^="QR"]', { state: 'detached' });

  // Журнал: записи всех действий выше, live-лента и раскрытые детали
  await page.goto(`${base}/audit`);
  await page.waitForSelector('tr[data-seq]');
  // Live включён по умолчанию — ждём подключения SSE (кнопка нажата и без «Подключаюсь…»)
  await page.waitForFunction(
    () => {
      const b = [...document.querySelectorAll('button[aria-pressed="true"]')].find((x) =>
        x.textContent?.includes('Live'),
      );
      return Boolean(b) && !b.textContent?.includes('…');
    },
    undefined,
    { timeout: 10_000 },
  );
  await shot('14-audit');
  // действие в другой вкладке → строка должна появиться без перезагрузки
  const before = await page.locator('tr[data-seq]').count();
  const topSeq = await page.locator('tr[data-seq]').first().getAttribute('data-seq');
  const tab2 = await ctx.newPage();
  await tab2.goto(`${base}/settings/appearance`);
  await tab2.locator('#brand-name').fill('Live[#accent]Test');
  await tab2.getByRole('button', { name: 'Сохранить' }).click();
  await tab2.waitForSelector('text=Логотип и название сохранены');
  await page.waitForFunction(
    (seq) => document.querySelector('tr[data-seq]')?.getAttribute('data-seq') !== seq,
    topSeq,
    { timeout: 10_000 },
  );
  log(
    `audit live: new row arrived via SSE (rows ${before} → ${await page.locator('tr[data-seq]').count()}) ✔`,
  );
  await tab2.getByRole('button', { name: 'Вернуть стандартные' }).click();
  await tab2.waitForSelector('text=Вернул стандартный');
  await tab2.close();
  await page.locator('tr[data-seq]').first().click();
  await page.waitForSelector('[data-testid="audit-details"]');
  await shot('15-audit-live-details');
  for (const t of ['light', 'black']) {
    await setTheme(t);
    await shot(`14-audit-${t}`);
  }
  await setTheme('dark');

  await browser.close();
  api.kill('SIGTERM');
  web.kill('SIGTERM');
  log('done →', OUT);
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  console.error('url at failure:', globalThis.__page?.url());
  for (const [name, proc] of Object.entries(globalThis.__procs ?? {}))
    console.error(`--- ${name} output (tail) ---\n${String(proc.out ?? '').slice(-3000)}`);
  console.error('last api calls:\n' + (globalThis.__apiLog ?? []).slice(-8).join('\n'));
  process.exit(1);
});
