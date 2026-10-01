import type { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import {
  auditListResponseSchema,
  CSRF_HEADER,
  notificationsResponseSchema,
  serverSchema,
  telegramSettingsSchema,
  WATCHDOG_PROBLEM,
  watchdogStatusSchema,
  watchdogTestResponseSchema,
} from '@nodeservice/shared';
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
import { WatchdogService } from '../src/modules/health/watchdog.service.js';
import { TELEGRAM_CLIENT, type TelegramCall } from '../src/modules/notifications/telegram/telegram.client.js';
import { FakeSsh, SSH_PASSWORD, SSH_USER } from './fake-ssh.js';

if (!process.env.DATABASE_URL?.endsWith('/nodeservice_test'))
  throw new Error('e2e: DATABASE_URL должен указывать на nodeservice_test');

const TOKEN = '123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw';
const TOKEN2 = '987654321:BBHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw';

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
  const ssh = new FakeSsh();
  const tg = new FakeTelegram();
  let serverId = '';
  let otherId = '';

  beforeAll(async () => {
    await ssh.start();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(TELEGRAM_CLIENT)
      .useValue(tg)
      .compile();
    app = moduleRef.createNestApplication<NestExpressApplication>({ bufferLogs: false, logger: false });
    setupHttp(app as NestExpressApplication);
    const db = app.get<Db>(DB);
    await runMigrations(db);
    await db.execute(
      sql`truncate users, recovery_codes, trusted_devices, setup_tokens, servers, incidents, notifications cascade`,
    );
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
    const add = async (name: string) =>
      serverSchema.parse(
        (
          await agent
            .post('/api/servers')
            .set(CSRF_HEADER, csrf)
            .send({
              name,
              host: '127.0.0.1',
              port: ssh.port,
              sshUser: SSH_USER,
              auth: { method: 'password', password: SSH_PASSWORD },
            })
            .expect(201)
        ).body,
      ).id;
    serverId = await add('Германия-1');
    otherId = await add('Москва-2');
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await ssh.stop();
  });

  const waitTexts = async (n: number) => {
    for (let i = 0; i < 50; i += 1) {
      if (tg.texts.length >= n) return;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`ждали ${n} сообщений, пришло ${tg.texts.length}`);
  };
  const watchdog = async () =>
    watchdogStatusSchema.parse((await agent.get('/api/settings/watchdog').expect(200)).body);
  const post = (path: string, body: unknown = {}) =>
    agent.post(`/api/settings/watchdog/${path}`).set(CSRF_HEADER, csrf).send(body);
  /** Файл настроек сторожа приходит на stdin SSH-команды, поэтому токенов нет в списке процессов. */
  const envOf = () => ssh.watchdog.installInput;

  describe('готовность', () => {
    it('всё работает — 200 без входа: база, Valkey, хранилище метрик и поиск инцидентов', async () => {
      // В сквозных тестах задачи сами не тикают — отметку поиска инцидентов ставим сами.
      app.get(PanelPulse).incidentsTick();
      const res = await request(app.getHttpServer()).get('/api/health/ready').expect(200);
      expect(res.body.status).toBe('ok');
      for (const k of ['postgres', 'valkey', 'metrics', 'incidents'])
        expect(res.body.checks[k].ok, k).toBe(true);
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

  describe('оповещения о себе самой: колокольчик и Telegram', () => {
    it('тумблер «Сбои самой панели» есть и по умолчанию включён', async () => {
      const s = telegramSettingsSchema.parse((await agent.get('/api/settings/telegram').expect(200)).body);
      expect(s.events.panel_health).toBe(true);
    });

    it('«Панель перезапустилась после сбоя» — в колокольчике и в Telegram; повтор в те же сутки молчит', async () => {
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
      const bell = notificationsResponseSchema.parse(
        (await agent.get('/api/notifications').expect(200)).body,
      );
      expect(bell.items.map((n) => n.title)).toContain('Панель перезапустилась после сбоя');
      // Отметка «сообщали» — в базе: второй сбой в те же сутки не шлётся.
      await alerts.crashed(new Date(Date.now() - 60_000), new Date());
      await new Promise((r) => setTimeout(r, 300));
      expect(tg.texts).toHaveLength(before + 1);
      const row = await app
        .get<Db>(DB)
        .execute<{ value: string }>(sql`select value from app_meta where key = 'panel.alerts'`);
      expect(JSON.parse(row.rows[0]?.value ?? '{}').crash).toMatchObject({ skipped: 1 });
    });

    it('тумблер выключен — в Telegram не приходит, в колокольчике остаётся', async () => {
      await agent
        .put('/api/settings/telegram')
        .set(CSRF_HEADER, csrf)
        .send({ events: { panel_health: false } })
        .expect(200);
      const before = tg.texts.length;
      await app.get(PanelAlertsService).diskLow({ freeBytes: 1024 ** 3, totalBytes: 40 * 1024 ** 3 });
      await new Promise((r) => setTimeout(r, 300));
      expect(tg.texts).toHaveLength(before);
      const bell = notificationsResponseSchema.parse(
        (await agent.get('/api/notifications').expect(200)).body,
      );
      expect(bell.items.map((n) => n.title)).toContain('Мало места на сервере панели');
      await agent
        .put('/api/settings/telegram')
        .set(CSRF_HEADER, csrf)
        .send({ events: { panel_health: true } })
        .expect(200);
    });
  });

  describe('сторож панели на сервере парка', () => {
    it('у панели локальный адрес — поставить нельзя, и сказано почему', async () => {
      const s = await watchdog();
      expect(s.installed).toBeNull();
      expect(s.blocker).toMatch(/^Панель открыта по локальному адресу/);
      const res = await post('install', { serverId }).expect(409);
      expect(res.body.type).toBe(WATCHDOG_PROBLEM.blocked);
      expect(ssh.execLog.some((c) => c.includes('# ns-watchdog:'))).toBe(false);
    });

    it('установка: по SSH — скрипт, настройки с токеном и адресом готовности панели; в Журнале без токена', async () => {
      app.get(WatchdogService).panelUrl = 'https://panel.example.com';
      expect((await watchdog()).blocker).toBeNull();
      const s = watchdogStatusSchema.parse((await post('install', { serverId }).expect(200)).body);
      expect(s.installed).toMatchObject({
        serverId,
        serverName: 'Германия-1',
        serverGone: false,
        outdated: false,
      });
      expect(ssh.watchdog.installed).toBe(true);
      const cmd = ssh.execLog.find((c) => c.includes('# ns-watchdog:install')) ?? '';
      const env = envOf();
      expect(env).toContain("PANEL_URL='https://panel.example.com/api/health/ready'");
      expect(env).toContain(`DESTINATIONS='${TOKEN}|-1002946167407|'`);
      expect(env).toContain("SERVER_NAME='Германия-1'");
      expect(cmd).toContain('chmod 600 "$R/etc/nodeservice-watchdog.env.new"');
      expect(cmd).not.toContain(TOKEN);
      const audit = auditListResponseSchema.parse(
        (await agent.get('/api/audit?page=1&pageSize=20').expect(200)).body,
      );
      const rec = audit.items.find((i) => i.action === 'settings.watchdog.installed');
      expect(rec).toMatchObject({ result: 'ok', targetDisplay: 'Германия-1' });
      expect(JSON.stringify(audit.items)).not.toContain(TOKEN);
    });

    it('«Проверить сторожа» — ответ самого сторожа по-русски', async () => {
      const r = watchdogTestResponseSchema.parse((await post('test').expect(200)).body);
      expect(r).toEqual({
        ok: true,
        detail:
          'Сторож на сервере «Германия-1» на месте: тестовое сообщение отправлено, панель с этого сервера отвечает.',
      });
      ssh.watchdog.test = '@@panel=нет ответа за 10 с\n@@sent=1\n';
      const bad = watchdogTestResponseSchema.parse((await post('test').expect(200)).body);
      expect(bad.ok).toBe(false);
      expect(bad.detail).toContain('панель с сервера «Германия-1» сейчас не отвечает (нет ответа за 10 с)');
      ssh.watchdog.test = '@@panel=ok\n@@sent=1\n';
    });

    it('сторож один: на другой сервер — только после снятия; чаты поменялись — «поставьте заново»', async () => {
      const busy = await post('install', { serverId: otherId }).expect(409);
      expect(busy.body.detail).toBe(
        'Сторож уже стоит на сервере «Германия-1». Сначала уберите его там: сторож нужен один.',
      );
      const tgs = telegramSettingsSchema.parse((await agent.get('/api/settings/telegram').expect(200)).body);
      await agent
        .put('/api/settings/telegram')
        .set(CSRF_HEADER, csrf)
        .send({ destinations: [{ id: tgs.destinations[0]?.id }, { url: `tgram://${TOKEN2}/412345678` }] })
        .expect(200);
      expect((await watchdog()).installed?.outdated).toBe(true);
      // Поставить заново там же — с новыми чатами.
      const again = watchdogStatusSchema.parse((await post('install', { serverId }).expect(200)).body);
      expect(again.installed?.outdated).toBe(false);
      const last = ssh.execLog.filter((c) => c.includes('# ns-watchdog:install')).at(-1) ?? '';
      expect(last).not.toContain(TOKEN2);
      expect(envOf()).toContain(`DESTINATIONS='${TOKEN}|-1002946167407| ${TOKEN2}|412345678|'`);
    });

    it('установка не удалась — причина по-русски, запись о стороже прежняя', async () => {
      ssh.watchdog.install = {
        code: 3,
        output:
          '@@error=Сервер не поддерживает службы по расписанию — сторожа на нём не поставить. Выберите другой сервер.\n',
      };
      try {
        const res = await post('install', { serverId }).expect(502);
        expect(res.body).toMatchObject({
          type: WATCHDOG_PROBLEM.failed,
          detail:
            'Сервер не поддерживает службы по расписанию — сторожа на нём не поставить. Выберите другой сервер.',
        });
        expect((await watchdog()).installed?.serverId).toBe(serverId);
      } finally {
        ssh.watchdog.install = { code: 0, output: '@@installed=1\n' };
      }
    });

    it('снятие: по SSH убирает сторожа; проверять больше нечего', async () => {
      const s = watchdogStatusSchema.parse((await post('remove').expect(200)).body);
      expect(s.installed).toBeNull();
      expect(ssh.watchdog.installed).toBe(false);
      expect(ssh.execLog.some((c) => c.includes('# ns-watchdog:remove'))).toBe(true);
      await post('test').expect(409);
      const audit = auditListResponseSchema.parse(
        (await agent.get('/api/audit?page=1&pageSize=20').expect(200)).body,
      );
      expect(audit.items.find((i) => i.action === 'settings.watchdog.removed')).toMatchObject({
        result: 'ok',
        targetDisplay: 'Германия-1',
      });
    });

    it('сервер удалили из панели — сторож помечен, «Убрать» просто забывает запись', async () => {
      await post('install', { serverId: otherId }).expect(200);
      await agent.delete(`/api/servers/${otherId}`).set(CSRF_HEADER, csrf).expect(204);
      const s = await watchdog();
      expect(s.installed).toMatchObject({ serverName: 'Москва-2', serverGone: true });
      const removes = ssh.execLog.filter((c) => c.includes('# ns-watchdog:remove')).length;
      expect((await post('remove').expect(200)).body.installed).toBeNull();
      expect(ssh.execLog.filter((c) => c.includes('# ns-watchdog:remove'))).toHaveLength(removes);
    });
  });
});
