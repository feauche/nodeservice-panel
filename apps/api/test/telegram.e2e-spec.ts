import type { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { CSRF_HEADER, serverSchema, telegramSettingsSchema } from '@nodeservice/shared';
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
import { IncidentReminderJob } from '../src/modules/incidents/incident-reminder.job.js';
import { IncidentsRepository } from '../src/modules/incidents/incidents.repository.js';
import { IncidentsService } from '../src/modules/incidents/incidents.service.js';
import { TELEGRAM_CLIENT, type TelegramCall } from '../src/modules/notifications/telegram/telegram.client.js';
import { TelegramService } from '../src/modules/notifications/telegram/telegram.service.js';
import { FakeSsh, SSH_PASSWORD, SSH_USER } from './fake-ssh.js';

if (!process.env.DATABASE_URL?.endsWith('/nodeservice_test'))
  throw new Error('e2e: DATABASE_URL должен указывать на nodeservice_test');

const LOGIN = 'admin';
const PASSWORD = 'correct horse battery staple';
const TOKEN = '123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw';

/** Поддельный Bot API: записывает вызовы; чат -100999 «не найден». */
class FakeTelegram {
  calls: Array<{ token: string; method: string; body: Record<string, unknown> }> = [];
  private next = 100;
  /** message_id каждого успешного sendMessage — по порядку. */
  ids: number[] = [];
  async call<T>(token: string, method: string, body: Record<string, unknown>): Promise<TelegramCall<T>> {
    this.calls.push({ token, method, body });
    if (body.chat_id === '-100999')
      return { ok: false, status: 400, description: 'Bad Request: chat not found' };
    if (method === 'getMe') return { ok: true, result: { username: 'ns_test_bot' } as T };
    if (method === 'getChat') return { ok: true, result: { title: 'VPN-алерты', type: 'supergroup' } as T };
    this.next += 1;
    this.ids.push(this.next);
    return { ok: true, result: { message_id: this.next } as T };
  }
  sent() {
    return this.calls.filter((c) => c.method === 'sendMessage');
  }
}
describe('telegram e2e', () => {
  let app: INestApplication;
  const tg = new FakeTelegram();
  let agent: InstanceType<typeof TestAgent>;
  let csrf: string;
  const ssh = new FakeSsh();
  let serverId = '';

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
      sql`truncate users, recovery_codes, trusted_devices, setup_tokens, servers, incidents cascade`,
    );
    await db.execute(
      sql`delete from app_meta where key like 'settings.%' or key like 'telegram.%' or key = 'panel.ssh-key'`,
    );
    await app.get<Redis>(VALKEY).flushdb();
    await app.init();
    agent = request.agent(app.getHttpServer());
    csrf = (await agent.get('/api/auth/csrf').expect(200)).body.token as string;
    const setupToken = await app.get(SetupService).issueToken();
    const start = await agent
      .post('/api/auth/setup/start')
      .set(CSRF_HEADER, csrf)
      .send({ setupToken, login: LOGIN, password: PASSWORD })
      .expect(200);
    await agent
      .post('/api/auth/setup/confirm')
      .set(CSRF_HEADER, csrf)
      .send({ code: await generate({ secret: start.body.totpSecret as string }) })
      .expect(200);
    const created = await agent
      .post('/api/servers')
      .set(CSRF_HEADER, csrf)
      .send({
        name: 'tg-host',
        host: '127.0.0.1',
        port: ssh.port,
        sshUser: SSH_USER,
        auth: { method: 'password', password: SSH_PASSWORD },
      })
      .expect(201);
    serverId = serverSchema.parse(created.body).id;
    // Создание сервера фоном авто-устанавливает агента (→ статус pending). Дождёмся,
    // чтобы её отложенный апдейт статуса не перебивал состояние, которое задают тесты.
    const db2 = app.get<Db>(DB);
    for (let i = 0; i < 60; i += 1) {
      const r = await db2.execute<{ agent_status: string }>(
        sql`select agent_status from servers where id = ${serverId}`,
      );
      if (r.rows[0]?.agent_status === 'pending') break;
      await new Promise((res) => setTimeout(res, 100));
    }
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await ssh.stop();
  });

  const put = (body: unknown, expected = 200) =>
    agent.put('/api/settings/telegram').set(CSRF_HEADER, csrf).send(body).expect(expected);
  const waitSent = async (n: number) => {
    for (let i = 0; i < 50; i += 1) {
      if (tg.sent().length >= n) return;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`ждали ${n} сообщений, пришло ${tg.sent().length}`);
  };

  it('по умолчанию чатов нет; неверная ссылка — отказ с подсказкой формата', async () => {
    const s = telegramSettingsSchema.parse((await agent.get('/api/settings/telegram').expect(200)).body);
    expect(s.destinations).toEqual([]);
    expect(s.events.incident_crit).toBe(true);
    expect(s.events.maintenance).toBe(false);
    const bad = await put({ destinations: [{ url: 'tgram://нет' }] }, 400);
    expect(JSON.stringify(bad.body)).toContain('tgram://токен_бота');
  });

  it('сохранение: токен скрыт везде, имя бота и чата подтянуты, повтор той же ссылки не дублируется', async () => {
    const url = `tgram://${TOKEN}/-1002946167407:8`;
    const res = await put({ destinations: [{ url }, { url }] });
    expect(JSON.stringify(res.body)).not.toContain(TOKEN);
    const s = telegramSettingsSchema.parse(res.body);
    expect(s.destinations).toHaveLength(1);
    expect(s.destinations[0]).toMatchObject({
      masked: 'tgram://***/-1002946167407:8',
      topic: 8,
      botName: '@ns_test_bot',
      chatTitle: 'VPN-алерты',
    });
    const again = await agent.get('/api/settings/telegram').expect(200);
    expect(JSON.stringify(again.body)).not.toContain(TOKEN);
    const audit = await agent.get('/api/audit?action=settings.telegram.updated').expect(200);
    expect(JSON.stringify(audit.body)).not.toContain(TOKEN);
  });

  it('тест: доставлено — отметка у чата; ошибка Telegram — понятной фразой; тема уходит в message_thread_id', async () => {
    const s = telegramSettingsSchema.parse((await agent.get('/api/settings/telegram').expect(200)).body);
    const id = s.destinations[0]?.id;
    const ok = await agent
      .post('/api/settings/telegram/test')
      .set(CSRF_HEADER, csrf)
      .send({ id })
      .expect(200);
    expect(ok.body).toMatchObject({ ok: true, detail: 'Тест доставлен' });
    expect(tg.sent().at(-1)?.body).toMatchObject({ chat_id: '-1002946167407', message_thread_id: 8 });
    const after = telegramSettingsSchema.parse((await agent.get('/api/settings/telegram').expect(200)).body);
    expect(after.destinations[0]?.lastTest?.ok).toBe(true);
    const bad = await agent
      .post('/api/settings/telegram/test')
      .set(CSRF_HEADER, csrf)
      .send({ url: `tgram://${TOKEN}/-100999` })
      .expect(200);
    expect(bad.body.ok).toBe(false);
    expect(bad.body.detail).toContain('добавьте бота');
  });

  it('инцидент: сообщение в чат, «Починилось» — ответом на него', async () => {
    const before = tg.sent().length;
    const db = app.get<Db>(DB);
    const svc = app.get(IncidentsService);
    const noMetrics = { cpu: new Map(), mem: new Map(), disk: new Map() };
    await db.execute(sql`update servers set agent_status = 'offline' where id = ${serverId}`);
    await svc.evaluate(noMetrics);
    await waitSent(before + 1);
    const opened = tg.sent()[before];
    expect(opened?.body.parse_mode).toBe('HTML');
    expect(String(opened?.body.text)).toContain('tg-host');
    const openedId = tg.ids.at(-1);

    await db.execute(sql`update servers set agent_status = 'online' where id = ${serverId}`);
    await svc.evaluate(noMetrics);
    await waitSent(before + 2);
    const resolved = tg.sent().at(-1);
    expect(String(resolved?.body.text)).toContain('✅');
    expect(resolved?.body.reply_parameters).toMatchObject({ allow_sending_without_reply: true });
    // «Починилось» — ответом именно на сообщение об открытии инцидента.
    expect(resolved?.body.reply_parameters).toMatchObject({ message_id: openedId });
  });

  it('тумблер выключен — в Telegram не уходит; чат удалён — тоже', async () => {
    await put({
      events: { incident_crit: false, incident_warn: false, needs_confirm: false, resolved: false },
    });
    const before = tg.sent().length;
    const db = app.get<Db>(DB);
    const noMetrics = { cpu: new Map(), mem: new Map(), disk: new Map() };
    await db.execute(sql`update servers set agent_status = 'offline' where id = ${serverId}`);
    await app.get(IncidentsService).evaluate(noMetrics);
    await new Promise((r) => setTimeout(r, 500));
    expect(tg.sent().length).toBe(before);
    const cleared = telegramSettingsSchema.parse((await put({ destinations: [] })).body);
    expect(cleared.destinations).toEqual([]);
  });

  it('склейка по серверу, без звука, выключенный вид и напоминание', async () => {
    const all = Object.fromEntries(
      ['incident_crit', 'incident_warn', 'needs_confirm', 'resolved', 'reminder'].map((k) => [k, true]),
    );
    await put({
      destinations: [{ url: `tgram://${TOKEN}/-1002946167407` }],
      events: all,
      kinds: { ssh_down: true, agent_offline: true, disk_high: true },
      delivery: { groupPerServer: true, silentWarnings: true, remindHours: 1 },
    });
    await app.get<Db>(DB).execute(sql`update incidents set status = 'resolved' where status <> 'resolved'`);
    const repo = app.get(IncidentsRepository);
    const tgs = app.get(TelegramService);
    const open = async (kind: 'agent_offline' | 'ssh_down' | 'disk_high', severity: 'crit' | 'warn') => {
      const row = await repo.open({
        serverId,
        serverName: 'tg-host',
        kind,
        severity,
        title: `${kind} · tg-host`,
        detail: 'Проверка.',
        timeline: [],
      });
      if (!row) throw new Error('инцидент не открылся');
      return row;
    };
    const a = await open('agent_offline', 'crit');
    await tgs.dispatch({
      event: 'incident_crit',
      kind: 'agent_offline',
      incidentId: a.id,
      serverKey: serverId,
      title: 'Агент не в сети',
    });
    const first = tg.sent().at(-1);
    const firstId = tg.ids.at(-1);
    expect(first?.body.disable_notification).toBeUndefined();

    // Второй сбой того же сервера за 10 минут — ответом на первый и без звука.
    const b = await open('ssh_down', 'crit');
    await tgs.dispatch({
      event: 'incident_crit',
      kind: 'ssh_down',
      incidentId: b.id,
      serverKey: serverId,
      title: 'SSH недоступен',
    });
    const second = tg.sent().at(-1);
    expect(second?.body.reply_parameters).toMatchObject({ message_id: firstId });
    expect(second?.body.disable_notification).toBe(true);

    // Предупреждение — тихо.
    const c = await open('disk_high', 'warn');
    await tgs.dispatch({
      event: 'incident_warn',
      kind: 'disk_high',
      incidentId: c.id,
      title: 'Диск заполняется',
    });
    expect(tg.sent().at(-1)?.body.disable_notification).toBe(true);

    // Выключенный вид не приходит совсем.
    await put({ kinds: { disk_high: false } });
    const before = tg.sent().length;
    await tgs.dispatch({ event: 'resolved', kind: 'disk_high', incidentId: c.id, title: 'Починилось' });
    expect(tg.sent().length).toBe(before);

    // Напоминание: последнее сообщение по критичному старше часа — ответом на исходное и со звуком.
    const db = app.get<Db>(DB);
    await db.execute(
      sql`update telegram_messages set created_at = now() - interval '2 hours' where incident_id = ${a.id}`,
    );
    await app.get(IncidentReminderJob).run();
    const reminders = tg.sent().filter((m) => String(m.body.text).includes('Всё ещё не решено'));
    expect(reminders.length).toBeGreaterThanOrEqual(1);
    const rem = reminders.find((m) => String(m.body.text).includes('agent_offline'));
    expect(rem?.body.reply_parameters).toMatchObject({ message_id: firstId });
    expect(rem?.body.disable_notification).toBeUndefined();
    // Повторный прогон сразу — второго напоминания нет.
    const n = tg.sent().length;
    await app.get(IncidentReminderJob).run();
    expect(tg.sent().filter((m) => String(m.body.text).includes('agent_offline')).length).toBe(
      tg
        .sent()
        .slice(0, n)
        .filter((m) => String(m.body.text).includes('agent_offline')).length,
    );
  });
});
