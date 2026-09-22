/**
 * Скриншоты состояний, недостижимых в обычном сценарии, — через MSW-моки (VITE_MOCK=1):
 *  - диалог step-up (пароль ещё раз),
 *  - коды восстановления без шифрованной копии.
 * Запуск: node scripts/mock-shots.mjs [outDir]  (поднимает vite на :5203 сам).
 */
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = process.argv[2] ?? join(root, 'docs', 'screenshots');
const PORT = 5203;
mkdirSync(OUT, { recursive: true });

const web = spawn('pnpm', ['exec', 'vite', '--port', String(PORT), '--strictPort'], {
  cwd: join(root, 'apps', 'web'),
  env: { ...process.env, VITE_MOCK: '1' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let webOut = '';
web.stdout.on('data', (d) => (webOut += d));
web.stderr.on('data', (d) => (webOut += d));
const until = async (fn, ms = 20000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      if (await fn()) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`timeout: ${webOut.slice(-1500)}`);
};

const browser = await chromium.launch();
try {
  await until(async () => (await fetch(`http://127.0.0.1:${PORT}/`)).ok);
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
  page.on('pageerror', (e) => console.log('PAGE ERROR', e.message));
  await page.goto(`http://127.0.0.1:${PORT}/login`);
  await page.waitForSelector('input');
  await page.locator('input').nth(0).fill('admin');
  await page.locator('input[type=password]').fill('correct horse battery');
  await page.getByRole('button', { name: /Войти/ }).click();
  const otp = page.getByLabel('Код из приложения, 6 цифр');
  await otp.waitFor();
  await otp.fill('123456');
  await page.waitForURL((u) => !u.pathname.startsWith('/login'));
  // Обзор — первый экран после входа
  await page.waitForSelector('text=Последние события');
  await page.waitForTimeout(500);
  await page.screenshot({ path: join(OUT, 'm10-overview.png') });

  // Обзор без метрик: пустые состояния по центру
  await page.evaluate(() => {
    window.__nsMockMetrics.hasData = false;
  });
  await page.getByRole('link', { name: 'Серверы', exact: true }).click();
  await page.waitForSelector('text=de-fra-01');
  await page.getByRole('link', { name: 'Обзор' }).click();
  await page.waitForSelector('text=Пока нет данных');
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(OUT, 'm10b-overview-empty.png') });
  await page.evaluate(() => {
    window.__nsMockMetrics.hasData = true;
  });

  // состояние мока живёт в памяти вкладки — по ссылкам, без перезагрузки
  await page.getByRole('link', { name: 'Настройки' }).click();
  await page.getByRole('link', { name: 'Безопасность' }).click();
  await page.waitForSelector('text=включена');

  await page.evaluate(() => {
    window.__nsMock.stepUpFresh = false;
  });
  await page.getByRole('switch').click();
  await page.getByRole('button', { name: 'Сохранить' }).click();
  const dialog = page.getByRole('dialog', { name: 'Подтверди пароль' });
  await dialog.waitFor();
  await dialog.locator('input[type=password]').fill('correct horse battery');
  await page.waitForTimeout(400); // дождаться анимации открытия
  await page.screenshot({ path: join(OUT, 'm1-step-up.png') });
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'detached' });

  await page.getByRole('button', { name: 'Выпустить новые' }).click();
  await page.getByRole('alertdialog', { name: 'Выпустить новые коды?' }).waitFor();
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(OUT, 'm3-confirm.png') });
  await page.keyboard.press('Escape');
  await page.getByRole('alertdialog').waitFor({ state: 'detached' });

  await page.evaluate(() => {
    window.__nsMock.stepUpFresh = true;
    window.__nsMock.codes = window.__nsMock.codes.map((c) => ({ ...c, code: null }));
  });
  await page.getByRole('button', { name: 'Показать', exact: true }).click();
  await page.waitForSelector('[data-testid="recovery-codes-legacy"]');
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(OUT, 'm2-recovery-codes-legacy.png') });
  await page.keyboard.press('Escape');

  // Настройки → Автопроверки
  await page.getByRole('link', { name: 'Автопроверки' }).click();
  await page.getByRole('switch', { name: 'Серверы без агента' }).waitFor();
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(OUT, 'm6-autochecks.png') });

  await page.getByRole('link', { name: 'Серверы', exact: true }).click();
  await page.waitForSelector('text=de-fra-01');
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(OUT, 'm4-servers.png') });

  // Выпадающий фильтр по тегам
  await page.getByRole('button', { name: 'Теги' }).click();
  await page.getByRole('menuitemradio', { name: 'Все серверы' }).waitFor();
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(OUT, 'm4b-servers-tags.png') });
  await page.keyboard.press('Escape');

  // «Дублировать»: копия появляется сразу
  await page.getByRole('button', { name: 'Действия с de-fra-01', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Дублировать' }).click();
  await page.waitForSelector('text=de-fra-01-2');
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(OUT, 'm4c-servers-duplicate.png') });

  // Установка агента: диалог с кнопкой «Установить по SSH» и ручной командой
  await page.getByRole('button', { name: 'Действия с de-fra-01', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Установить агента' }).click();
  await page.getByRole('dialog', { name: 'Установка агента' }).waitFor();
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(OUT, 'm9-agent-install.png') });
  await page.keyboard.press('Escape');
  await page.getByRole('dialog').waitFor({ state: 'detached' });

  // Перетаскивание: ручка ⠿ у de-fra-01, тянем на место nl-ams-02
  const dragHandle = page.getByRole('button', { name: 'Перетащить «de-fra-01»' });
  const dragTarget = page.getByText('nl-ams-02', { exact: true });
  const hb = await dragHandle.boundingBox();
  const tb = await dragTarget.boundingBox();
  if (!hb || !tb) throw new Error('drag: не нашёл ручку или цель');
  await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
  await page.mouse.down();
  await page.mouse.move(tb.x + 40, tb.y + 30, { steps: 14 });
  await page.waitForTimeout(200);
  await page.screenshot({ path: join(OUT, 'm4g-servers-drag.png') });
  await page.mouse.up();
  await page.waitForTimeout(500);

  // Модалка сервера, вкладка «Подключение» — через меню «Изменить»
  await page.getByRole('button', { name: 'Действия с de-fra-01', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Изменить' }).click();
  const srvModal = page.getByRole('dialog', { name: 'de-fra-01' });
  await srvModal.waitFor();
  await srvModal.getByLabel('Название').waitFor();
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(OUT, 'm4e-server-connection.png') });

  // Веб-терминал: кнопка «SSH-терминал» открывает плавающее окно поверх модалки
  await srvModal.getByRole('button', { name: 'SSH-терминал' }).click();
  const term = page.getByRole('dialog', { name: /Терминал/ });
  await term.waitFor();
  await page.waitForTimeout(900);
  await page.screenshot({ path: join(OUT, 'm12-terminal.png') });
  await term.getByRole('button', { name: 'Закрыть' }).click();
  await term.waitFor({ state: 'detached' });
  await page.keyboard.press('Escape');
  await srvModal.waitFor({ state: 'detached' });
  // Модалка сервера, вкладка «Метрики» — клик по карточке (агент de-fra-01 в сети — метрики живые)
  await page.getByText('de-fra-01', { exact: true }).click();
  await page.getByRole('dialog', { name: 'de-fra-01' }).waitFor();
  await page.waitForSelector('text=Load average');
  await page.waitForTimeout(700);
  await page.screenshot({ path: join(OUT, 'm11-server-modal.png') });
  await page.keyboard.press('Escape');
  await page.getByRole('dialog', { name: 'de-fra-01' }).waitFor({ state: 'detached' });

  // Удаление при просроченном step-up: пароль обязан быть ПОВЕРХ подтверждения
  await page.evaluate(() => {
    window.__nsMock.stepUpFresh = false;
  });
  await page.getByRole('button', { name: 'Действия с de-fra-01', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Удалить' }).click();
  await page.getByRole('button', { name: 'Да, удалить' }).click();
  const stepUpDelete = page.getByRole('dialog', { name: 'Подтверди пароль' });
  await stepUpDelete.waitFor();
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(OUT, 'm4d-servers-delete-stepup.png') });
  await stepUpDelete.locator('input[type=password]').fill('correct horse battery');
  await stepUpDelete.getByRole('button', { name: 'Подтвердить' }).click();
  await page.getByText('de-fra-01', { exact: true }).waitFor({ state: 'detached' });

  await page.getByRole('button', { name: 'Добавить сервер' }).click();
  await page.getByRole('dialog', { name: 'Добавить сервер' }).waitFor();
  await page.getByLabel('Название').fill('fi-hel-03');
  await page.getByLabel('IP или домен').fill('198.51.100.99');
  await page.getByLabel('Пароль', { exact: true }).fill('root-password');
  await page.getByRole('button', { name: 'Проверить подключение' }).click();
  await page.waitForSelector('[data-testid="test-result"]');
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(OUT, 'm5-server-add.png') });
  // Журнал: раскрытая запись с кнопкой «Скопировать» (сначала закрыть диалог добавления)
  await page.keyboard.press('Escape');
  await page.getByRole('dialog').waitFor({ state: 'detached' });
  await page.getByRole('link', { name: 'Журнал' }).click();
  await page.waitForSelector('tbody tr');
  await page.locator('tbody tr').first().click();
  await page.waitForSelector('[data-testid="audit-details"]');
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(OUT, 'm8-audit-details.png') });

  // Инциденты: список + раскрытая карточка с таймлайном и автопочинкой
  await page.locator('a[href="/incidents"]').click();
  await page.waitForSelector('[data-testid="incident-card"]');
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(OUT, 'm13-incidents.png') });
  await page.locator('[data-testid="incident-card"]').first().click();
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(OUT, 'm13b-incident-detail.png') });

  // Настройки → Инциденты
  await page.getByRole('link', { name: 'Настройки', exact: true }).click();
  await page.locator('a[href="/settings/incidents"]').click();
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(OUT, 'm14-incidents-settings.png') });

  // База знаний: список + открытая статья
  await page.locator('a[href="/knowledge"]').click();
  await page.waitForTimeout(500);
  await page.screenshot({ path: join(OUT, 'm15-knowledge.png') });

  // База знаний: диалог истории версий
  await page.getByRole('button', { name: 'История версий' }).click();
  await page.getByRole('dialog', { name: 'История версий' }).waitFor();
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(OUT, 'm15c-kb-history.png') });
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);

  // База знаний: редактор новой статьи — выбор источника + подсветка кода в предпросмотре
  await page.getByRole('button', { name: 'Новая статья' }).click();
  await page.fill('#kb-title', 'Проверка ноды');
  await page.fill(
    '#kb-content',
    '## Быстрая проверка\n\n```bash\nsystemctl status xray\njournalctl -u xray -n 50\n```\n\nОтвет API:\n\n```json\n{ "status": "ok", "uptime": 8123 }\n```\n\n## Пояснения\n\n| Термин | Простыми словами |\n| --- | --- |\n| SSH | Защищённый способ зайти на сервер по сети |\n| conntrack | Таблица активных сетевых соединений в ядре Linux |\n',
  );
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(OUT, 'm15b-knowledge-editor.png') });

  // Ассистент: включаем ключ в моке
  await page.evaluate(() => {
    window.__nsMockAssistant.enabled = true;
  });
  await page.locator('a[href="/assistant"]').click();
  await page.getByLabel('Сообщение ассистенту').waitFor();
  await page.waitForTimeout(300);
  // Пустой чат: тумблер режима, быстрые вопросы, поле ввода
  await page.screenshot({ path: join(OUT, 'm16b-assistant-empty.png') });

  // Задаём вопрос, показываем ответ с цитатой и предложением
  await page.getByLabel('Сообщение ассистенту').fill('Что сейчас требует внимания?');
  await page.getByRole('button', { name: 'Отправить' }).click();
  await page.waitForTimeout(800);
  await page.screenshot({ path: join(OUT, 'm16-assistant.png') });

  // Настройки → Ассистент: уровень пользователя + разрешения (весь экран)
  await page.getByRole('link', { name: 'Настройки', exact: true }).click();
  await page.locator('a[href="/settings/assistant"]').click();
  await page.waitForSelector('#as-level');
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(OUT, 'm17-assistant-settings.png') });

  console.log('mock shots →', OUT);
} finally {
  await browser.close();
  web.kill('SIGTERM');
}
