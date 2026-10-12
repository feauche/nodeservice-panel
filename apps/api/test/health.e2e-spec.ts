import type { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { CSRF_HEADER, telegramSettingsSchema } from '@nodeservice/shared';
import { sql } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import { generate } from 'otplib';
import request from 'supertest';
import TestAgent from 'supertest/lib/agent.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AppModule } from '../src/app.module.js';
import { setupHttp } from '../src/common/http/setup-http.js';
import { DB, type Db } from '../src/infra/db/db.module.js';
import { runMigrations } from '../src/infra/db/migrate.js';
import { VALKEY } from '../src/infra/valkey/valkey.module.js';
import { SetupService } from '../src/modules/auth/setup.service.js';
import { NOT_READY_PROBLEM } from '../src/modules/health/health.controller.js';
import { PanelAlertsService } from '../src/modules/health/panel-alerts.service.js';
import { PanelPulse } from '../src/modules/health/panel-pulse.js';
import { TELEGRAM_CLIENT, type TelegramCall } from '../src/modules/notifications/telegram/telegram.client.js';

if (!process.env.DATABASE_URL?.endsWith('/nodeservice_test'))
  throw new Error('e2e: DATABASE_URL должен указывать на nodeservice_test');

const TOKEN = '123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw';

/** Поддельный Bot API: запоминает отправленные сообщения. */
class FakeTelegram {
  texts: string[] = [];
  async call<T>(_t: string, method: string, body: Record<string, unknown>): Promise<TelegramCall<T>> {
    if (method === 'sendMessage') this.texts.push(String(body.text));
    if (method === 'getMe') return { ok: true, result: { username: 'ns_test_bot' } as T };
    if (method === 'getChat') return { ok: true, result: { title: 'VPN-алерты', type: 'supergroup' } as T };
    return { ok: true, result: { message_id: this.texts.length } as T };
  }
  async sendFile<T>(): Promise<TelegramCall<T>> {
    return { ok: true, result: { message_id: 1 } as T };
  }
}

describe('панель следит за собой e2e', () => {
  let app: INestApplication;
  let agent: InstanceType<typeof TestAgent>;
  let csrf: string;
  const tg = new FakeTelegram();

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(TELEGRAM_CLIENT)
      .useValue(tg)
      .compile();
    app = moduleRef.createNestApplication<NestExpressApplication>({ bufferLogs: false, logger: false });
    setupHttp(app as NestExpressApplication);
    const db = app.get<Db>(DB);
    await runMigrations(db);
    await db.execute(sql`truncate users, recovery_codes, trusted_devices, setup_tokens, incidents cascade`);
    await db.execute(
      sql`delete from app_meta where key like 'settings.%' or key like 'telegram.%' or key in ('panel.ssh-key', 'panel.alerts', 'watchdog')`,
    );
    await app.get<Redis>(VALKEY).flushdb();
    await app.init();
    agent = request.agent(app.getHttpServer());
    csrf = (await agent.get('/api/auth/csrf').expect(200)).body.token as string;
    const setupToken = await app.get(SetupService).issueToken();
    const start = await agent
      .post('/api/auth/setup/start')
      .set(CSRF_HEADER, csrf)
      .send({ setupToken, login: 'admin', password: 'correct horse battery staple' })
      .expect(200);
    await agent
      .post('/api/auth/setup/confirm')
      .set(CSRF_HEADER, csrf)
      .send({ code: await generate({ secret: start.body.totpSecret as string }) })
      .expect(200);
  }, 60_000);

  afterAll(async () => {
    await app?.close();
  });

  const waitTexts = async (n: number) => {
    for (let i = 0; i < 50; i += 1) {
      if (tg.texts.length >= n) return;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`ждали ${n} сообщений, пришло ${tg.texts.length}`);
  };
  describe('готовность', () => {
    it('всё работает — 200 без входа: база, Valkey и поиск событий', async () => {
      // В сквозных тестах задачи сами не тикают — отметку поиска инцидентов ставим сами.
      app.get(PanelPulse).incidentsTick();
      const res = await request(app.getHttpServer()).get('/api/health/ready').expect(200);
      expect(res.body.status).toBe('ok');
      for (const k of ['postgres', 'valkey', 'incidents']) expect(res.body.checks[k].ok, k).toBe(true);
    });

    it('поиск инцидентов молчит дольше 3 минут — 503 с причиной по-русски; отработал — снова 200', async () => {
      const pulse = app.get(PanelPulse);
      pulse.incidentsTick(Date.now() - 6 * 60_000);
      const res = await request(app.getHttpServer()).get('/api/health/ready').expect(503);
      expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
      expect(res.body).toMatchObject({
        type: NOT_READY_PROBLEM,
        status: 503,
        detail: 'поиск инцидентов не отрабатывал 6 мин',
        problems: ['поиск инцидентов не отрабатывал 6 мин'],
      });
      expect(res.body.checks.postgres.ok).toBe(true);
      // Ни адресов, ни паролей в ответе, который видит кто угодно.
      expect(JSON.stringify(res.body)).not.toMatch(/postgres:\/\/|redis:\/\/|127\.0\.0\.1/);
      pulse.incidentsTick();
      await request(app.getHttpServer()).get('/api/health/ready').expect(200);
    });

    it('/api/health/live — как раньше, без проверок', async () => {
      const res = await request(app.getHttpServer()).get('/api/health/live').expect(200);
      expect(res.body.status).toBe('ok');
    });
  });

  describe('оповещения о себе самой: Telegram', () => {
    it('тумблер «Сбои самой панели» есть и по умолчанию включён', async () => {
      const s = telegramSettingsSchema.parse((await agent.get('/api/settings/telegram').expect(200)).body);
      expect(s.events.panel_health).toBe(true);
    });

    it('«Панель перезапустилась после сбоя» — в Telegram; повтор в те же сутки молчит', async () => {
      await agent
        .put('/api/settings/telegram')
        .set(CSRF_HEADER, csrf)
        .send({ destinations: [{ url: `tgram://${TOKEN}/-1002946167407` }] })
        .expect(200);
      const alerts = app.get(PanelAlertsService);
      const before = tg.texts.length;
      await alerts.crashed(new Date(Date.now() - 4 * 60_000), new Date());
      await waitTexts(before + 1);
      expect(tg.texts.at(-1)).toMatch(/^🖥 <b>Панель перезапустилась после сбоя<\/b>/);
      expect(tg.texts.at(-1)).toContain('Штатной остановки перед этим не было');
      // Отметка «сообщали» — в базе: второй сбой в те же сутки не шлётся.
      await alerts.crashed(new Date(Date.now() - 60_000), new Date());
      await new Promise((r) => setTimeout(r, 300));
      expect(tg.texts).toHaveLength(before + 1);
      const row = await app
        .get<Db>(DB)
        .execute<{ value: string }>(sql`select value from app_meta where key = 'panel.alerts'`);
      expect(JSON.parse(row.rows[0]?.value ?? '{}').crash).toMatchObject({ skipped: 1 });
    });

    it('тумблер выключен — в Telegram не приходит', async () => {
      await agent
        .put('/api/settings/telegram')
        .set(CSRF_HEADER, csrf)
        .send({ events: { panel_health: false } })
        .expect(200);
      const before = tg.texts.length;
      await app.get(PanelAlertsService).diskLow({ freeBytes: 1024 ** 3, totalBytes: 40 * 1024 ** 3 });
      await new Promise((r) => setTimeout(r, 300));
      expect(tg.texts).toHaveLength(before);
      await agent
        .put('/api/settings/telegram')
        .set(CSRF_HEADER, csrf)
        .send({ events: { panel_health: true } })
        .expect(200);
    });
  });

  describe('удалённый сторож', () => {
    it('статус и команды больше не доступны', async () => {
      await agent.get('/api/settings/watchdog').expect(404);
      for (const command of ['install', 'remove', 'test']) {
        await agent.post(`/api/settings/watchdog/${command}`).set(CSRF_HEADER, csrf).send({}).expect(404);
      }
    });
  });
});
