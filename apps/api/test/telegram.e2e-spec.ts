import type { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import {
  CSRF_HEADER,
  serverSchema,
  TELEGRAM_DELIVERY_DEFAULT,
  TELEGRAM_EVENTS,
  TELEGRAM_QUIET_DEFAULT,
  telegramSettingsSchema,
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
import { formatBillingMessage, formatBillingRichMessage } from '../src/modules/billing/billing.format.js';
import { IncidentReminderJob } from '../src/modules/incidents/incident-reminder.job.js';
import { IncidentsRepository } from '../src/modules/incidents/incidents.repository.js';
import { NotificationsRepository } from '../src/modules/notifications/notifications.repository.js';
import { NotificationsService } from '../src/modules/notifications/notifications.service.js';
import { TELEGRAM_CLIENT, type TelegramCall } from '../src/modules/notifications/telegram/telegram.client.js';
import { TelegramService } from '../src/modules/notifications/telegram/telegram.service.js';
import { TelegramSettingsStore } from '../src/modules/notifications/telegram/telegram-settings.store.js';
import { SettingsService } from '../src/modules/settings/settings.service.js';
import { FakeSsh, SSH_PASSWORD, SSH_USER } from './fake-ssh.js';

if (!process.env.DATABASE_URL?.endsWith('/nodeservice_test'))
  throw new Error('e2e: DATABASE_URL должен указывать на nodeservice_test');

const LOGIN = 'admin';
const PASSWORD = 'correct horse battery staple';
const TOKEN = '123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw';

/** Группа, которая «стала супергруппой»: Telegram отказывает и называет новый номер чата. */
const OLD_GROUP = '-555000';
const NEW_GROUP = '-1005550001';

/** Поддельный Bot API: записывает вызовы; чаты, начинающиеся с -100999, «не найдены». */
class FakeTelegram {
  calls: Array<{
    token: string;
    method: string;
    body: Record<string, unknown>;
    proxy?: string | null;
    at: number;
  }> = [];
  private next = 100;
  /** message_id каждого успешного sendMessage — по порядку. */
  ids: number[] = [];
  /**
   * Как сервер Bot API отвечает на расширенное оформление: принимает; не знает метода (старый сервер, 404);
   * не принимает разметку (400); связь оборвалась (исход неизвестен).
   */
  richMode: 'ok' | 'old-server' | 'bad-markup' | 'network' = 'ok';
  /** Полный обрыв для обычных и rich сообщений; служебные getMe/getChat продолжают отвечать. */
  networkDown = false;
  /** Следующие N отправок оборвутся; нужно для проверки порядка адресной очереди. */
  sendFailuresRemaining = 0;
  /** Следующая отправка получает настоящий ответ Bot API 429 с указанной паузой. */
  retryAfterSeconds: number | null = null;
  async call<T>(
    token: string,
    method: string,
    body: Record<string, unknown>,
    proxy?: string | null,
  ): Promise<TelegramCall<T>> {
    this.calls.push({ token, method, body, proxy: proxy ?? null, at: Date.now() });
    if (this.networkDown && (method === 'sendMessage' || method === 'sendRichMessage'))
      throw new Error('socket hang up');
    if (this.sendFailuresRemaining > 0 && (method === 'sendMessage' || method === 'sendRichMessage')) {
      this.sendFailuresRemaining -= 1;
      throw new Error('socket hang up');
    }
    if (this.retryAfterSeconds && (method === 'sendMessage' || method === 'sendRichMessage')) {
      const retryAfterSeconds = this.retryAfterSeconds;
      this.retryAfterSeconds = null;
      return {
        ok: false,
        status: 429,
        description: 'Too Many Requests: retry later',
        retryAfterSeconds,
      };
    }
    if (method === 'sendRichMessage' && this.richMode === 'old-server')
      return { ok: false, status: 404, description: 'Not Found: method not found' };
    if (method === 'sendRichMessage' && this.richMode === 'bad-markup')
      return {
        ok: false,
        status: 400,
        description: 'Bad Request: can\'t parse InputRichBlock: type "table" is unsupported',
      };
    if (method === 'sendRichMessage' && this.richMode === 'network') throw new Error('socket hang up');
    if (String(body.chat_id ?? '').startsWith('-100999'))
      return { ok: false, status: 400, description: 'Bad Request: chat not found' };
    if (body.chat_id === OLD_GROUP && method === 'sendMessage')
      return {
        ok: false,
        status: 400,
        description: 'Bad Request: group chat was upgraded to a supergroup chat',
        migrateToChatId: NEW_GROUP,
      };
    if (method === 'getMe') return { ok: true, result: { username: 'ns_test_bot' } as T };
    if (method === 'getChat') return { ok: true, result: { title: 'VPN-алерты', type: 'supergroup' } as T };
    this.next += 1;
    this.ids.push(this.next);
    return { ok: true, result: { message_id: this.next } as T };
  }
  sent() {
    return this.calls.filter((c) => c.method === 'sendMessage');
  }
  rich() {
    return this.calls.filter((c) => c.method === 'sendRichMessage');
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
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await ssh.stop();
  });

  const put = (body: unknown, expected = 200) =>
    agent.put('/api/settings/telegram').set(CSRF_HEADER, csrf).send(body).expect(expected);

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

  it('инцидент Remnawave: сообщение в чат, восстановление — ответом на него', async () => {
    const before = tg.sent().length;
    const tgs = app.get(TelegramService);
    const row = await app.get(IncidentsRepository).open({
      serverId,
      serverName: 'tg-host',
      kind: 'node_down',
      severity: 'crit',
      title: 'Нода недоступна',
      detail: 'Проверка.',
      timeline: [],
    });
    if (!row) throw new Error('инцидент не открылся');
    await tgs.dispatch({
      event: 'incident_crit',
      kind: 'node_down',
      incidentId: row.id,
      title: row.title,
      server: { id: serverId, name: 'tg-host' },
    });
    expect(tg.sent().length).toBe(before + 1);
    expect(String(tg.sent().at(-1)?.body.text)).toContain('tg-host');
    const openedId = tg.ids.at(-1);
    await app
      .get<Db>(DB)
      .execute(sql`update incidents set status='resolved', resolved_at=now() where id=${row.id}`);
    await tgs.dispatch({
      event: 'resolved',
      kind: 'node_down',
      incidentId: row.id,
      title: 'Нода восстановилась',
    });
    expect(tg.sent().length).toBe(before + 2);
    expect(tg.sent().at(-1)?.body.reply_parameters).toMatchObject({
      message_id: openedId,
      allow_sending_without_reply: true,
    });
  });

  it('категория сценариев независима от событий и приходит расширенным сообщением', async () => {
    await put({
      events: { incident_crit: false, incident_warn: false, scenario: true },
      quiet: { ...TELEGRAM_QUIET_DEFAULT, enabled: false },
      delivery: { ...TELEGRAM_DELIVERY_DEFAULT, rich: false, groupPerServer: false },
    });
    const service = app.get(TelegramService),
      before = tg.rich().length;
    await service.dispatch({
      event: 'scenario',
      title: 'Сценарий: Резерв',
      body: 'Нода: Германия\nУсловие: Нода потеряла связь И TCP недоступен\nРезультат: TCP недоступен; скрыто Host: 1',
      link: { to: '/scenarios', label: 'Открыть сценарии' },
    });
    expect(tg.rich().length).toBe(before + 1);
    expect(JSON.stringify(tg.rich().at(-1)?.body)).toContain('Сценарий: Резерв');
    expect(JSON.stringify(tg.rich().at(-1)?.body)).toContain('Сценарий ·');
    await put({ events: { incident_warn: true, scenario: false } });
    await service.dispatch({ event: 'scenario', title: 'Сценарий: не отправлять' });
    expect(tg.rich().length).toBe(before + 1);
    await put({ delivery: { ...TELEGRAM_DELIVERY_DEFAULT, rich: false } });
  });

  it('тумблер выключен и удалённый чат подавляют текущие инциденты', async () => {
    await put({ events: { incident_crit: false, incident_warn: false, resolved: false } });
    const before = tg.sent().length;
    await app
      .get(TelegramService)
      .dispatch({ event: 'incident_crit', kind: 'node_down', title: 'Не отправлять' });
    expect(tg.sent().length).toBe(before);
    const cleared = telegramSettingsSchema.parse((await put({ destinations: [] })).body);
    expect(cleared.destinations).toEqual([]);
    await app.get(TelegramService).dispatch({ event: 'login', title: 'Нет адресата' });
    expect(tg.sent().length).toBe(before);
  });

  it('склейка по серверу, без звука, выключенный вид и напоминание', async () => {
    const all = Object.fromEntries(
      ['incident_crit', 'incident_warn', 'needs_confirm', 'resolved', 'reminder'].map((k) => [k, true]),
    );
    await put({
      destinations: [{ url: `tgram://${TOKEN}/-1002946167407` }],
      events: all,
      kinds: { server_down: true, node_down: true, cpu_high: true },
      delivery: { groupPerServer: true, silentWarnings: true, remindHours: 1 },
    });
    await app.get<Db>(DB).execute(sql`update incidents set status = 'resolved' where status <> 'resolved'`);
    const repo = app.get(IncidentsRepository);
    const tgs = app.get(TelegramService);
    const open = async (kind: 'node_down' | 'server_down' | 'cpu_high', severity: 'crit' | 'warn') => {
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
    const a = await open('node_down', 'crit');
    await tgs.dispatch({
      event: 'incident_crit',
      kind: 'node_down',
      incidentId: a.id,
      serverKey: 'server:glue-isolated',
      title: 'Нода не на связи',
    });
    const first = tg.sent().at(-1);
    const firstId = tg.ids.at(-1);
    expect(first?.body.disable_notification).toBeUndefined();

    // Второй сбой того же сервера за 10 минут — ответом на первый и без звука.
    const b = await open('server_down', 'crit');
    await tgs.dispatch({
      event: 'incident_crit',
      kind: 'server_down',
      incidentId: b.id,
      serverKey: 'server:glue-isolated',
      title: 'TCP-порт недоступен',
    });
    const second = tg.sent().at(-1);
    expect(second?.body.reply_parameters).toMatchObject({ message_id: firstId });
    expect(second?.body.disable_notification).toBe(true);

    // Предупреждение — тихо.
    const c = await open('cpu_high', 'warn');
    await tgs.dispatch({
      event: 'incident_warn',
      kind: 'cpu_high',
      incidentId: c.id,
      title: 'Диск заполняется',
    });
    expect(tg.sent().at(-1)?.body.disable_notification).toBe(true);

    // Выключенный вид не приходит совсем.
    await put({ kinds: { cpu_high: false } });
    const before = tg.sent().length;
    await tgs.dispatch({ event: 'resolved', kind: 'cpu_high', incidentId: c.id, title: 'Починилось' });
    expect(tg.sent().length).toBe(before);

    // Напоминание: последнее сообщение по критичному старше часа — ответом на исходное и со звуком.
    const db = app.get<Db>(DB);
    await db.execute(
      sql`update telegram_messages set created_at = now() - interval '2 hours' where incident_id = ${a.id}`,
    );
    await app.get(IncidentReminderJob).run();
    const reminders = tg.sent().filter((m) => String(m.body.text).includes('Всё ещё не решено'));
    expect(reminders.length).toBeGreaterThanOrEqual(1);
    const rem = reminders.find((m) => String(m.body.text).includes('node_down'));
    expect(rem?.body.reply_parameters).toMatchObject({ message_id: firstId });
    expect(rem?.body.disable_notification).toBeUndefined();
    // Повторный прогон сразу — второго напоминания нет.
    const n = tg.sent().length;
    await app.get(IncidentReminderJob).run();
    expect(tg.sent().filter((m) => String(m.body.text).includes('node_down')).length).toBe(
      tg
        .sent()
        .slice(0, n)
        .filter((m) => String(m.body.text).includes('node_down')).length,
    );
  });

  it('прокси: маска без пароля, отправка через него, неверный формат — отказ, пусто — напрямую', async () => {
    const bad = await put({ proxy: 'socks://нет' }, 400);
    expect(JSON.stringify(bad.body)).toContain('socks5://');
    const res = telegramSettingsSchema.parse(
      (await put({ proxy: 'socks5://user:s3cret@10.0.0.5:1080' })).body,
    );
    expect(res.proxy).toBe('socks5://user:***@10.0.0.5:1080');
    const raw = await agent.get('/api/settings/telegram').expect(200);
    expect(JSON.stringify(raw.body)).not.toContain('s3cret');
    const audit = await agent.get('/api/audit?action=settings.telegram.updated').expect(200);
    expect(JSON.stringify(audit.body)).not.toContain('s3cret');
    const id = res.destinations[0]?.id;
    await agent.post('/api/settings/telegram/test').set(CSRF_HEADER, csrf).send({ id }).expect(200);
    expect(tg.sent().at(-1)?.proxy).toBe('socks5://user:s3cret@10.0.0.5:1080');
    // Тест с ещё не сохранённым прокси из поля.
    await agent
      .post('/api/settings/telegram/test')
      .set(CSRF_HEADER, csrf)
      .send({ id, proxy: 'http://10.0.0.6:3128' })
      .expect(200);
    expect(tg.sent().at(-1)?.proxy).toBe('http://10.0.0.6:3128');
    const cleared = telegramSettingsSchema.parse((await put({ proxy: '' })).body);
    expect(cleared.proxy).toBeNull();
    await agent.post('/api/settings/telegram/test').set(CSRF_HEADER, csrf).send({ id }).expect(200);
    expect(tg.sent().at(-1)?.proxy).toBeNull();
  });

  /* ---------- порядок, ночной режим и доставка ---------- */

  const ALL_EVENTS = Object.fromEntries(TELEGRAM_EVENTS.map((k) => [k, true]));
  const QUIET_OFF = { enabled: false, from: '23:00', to: '08:00', timeZone: 'Europe/Moscow' };
  const hhmm = (d: Date, timeZone: string) =>
    new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hour12: false })
      .format(d)
      .replace(/^24/, '00');
  /** Тихие часы, внутри которых «сейчас» — если смотреть по часам этого пояса. */
  const quietAround = (timeZone: string) => ({
    enabled: true,
    from: hhmm(new Date(Date.now() - 3_600_000), timeZone),
    to: hhmm(new Date(Date.now() + 3_600_000), timeZone),
    timeZone,
  });
  const textOf = (m: { body: Record<string, unknown> } | undefined) => String(m?.body.text ?? '');
  const digest = async () => {
    const r = await app
      .get<Db>(DB)
      .execute<{ value: string }>(sql`select value from app_meta where key = 'telegram.digest'`);
    return JSON.parse(r.rows[0]?.value ?? '[]') as Array<{ event: string; title: string }>;
  };
  /** Записи Журнала про Telegram, сделанные с указанного момента (в базе остаются записи прошлых прогонов). */
  const journal = async (action: string, since: Date) => {
    const res = await agent
      .get(`/api/audit?category=settings&pageSize=100&from=${encodeURIComponent(since.toISOString())}`)
      .expect(200);
    return (res.body.items as Array<Record<string, unknown>>).filter((e) => e.action === action);
  };
  const pendingCount = async () =>
    Number(
      (await app.get<Db>(DB).execute<{ n: number }>(sql`select count(*)::int as n from telegram_pending`))
        .rows[0]?.n ?? 0,
    );
  const outboxCount = async () =>
    Number(
      (await app.get<Db>(DB).execute<{ n: number }>(sql`select count(*)::int as n from telegram_outbox`))
        .rows[0]?.n ?? 0,
    );
  /** Чистый лист: дел нет, сервер на связи, сводка пуста, один рабочий чат, всё включено. */
  const fresh = async (extra: Record<string, unknown> = {}) => {
    const db = app.get<Db>(DB);
    await app.get(NotificationsService).settle();
    await db.execute(sql`update incidents set status = 'resolved' where status <> 'resolved'`);
    await db.execute(sql`delete from telegram_pending`);
    await db.execute(sql`delete from telegram_outbox`);
    await db.execute(sql`update servers set agent_status = 'online', ssh_ok = true where id = ${serverId}`);
    await db.execute(sql`delete from app_meta where key = 'telegram.digest'`);
    const s = telegramSettingsSchema.parse(
      (
        await put({
          destinations: [{ url: `tgram://${TOKEN}/-1002946167407` }],
          events: ALL_EVENTS,
          kinds: { server_down: true, node_down: true, cpu_high: true },
          // Склейка по серверу здесь не предмет проверки: прошлые тесты оставили «главный» сбой этого сервера.
          delivery: { groupPerServer: false, silentWarnings: true, remindHours: 2 },
          quiet: QUIET_OFF,
          ...extra,
        })
      ).body,
    );
    return s.destinations[0]?.id ?? '';
  };
  const openIncident = async (
    kind: 'node_down' | 'server_down' | 'mem_high' | 'cpu_high',
    severity: 'crit' | 'warn',
  ) => {
    const row = await app.get(IncidentsRepository).open({
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

  it('предупреждение, затем критичный сбой на том же сервере: критичный приходит со звуком и становится главным', async () => {
    await fresh({ delivery: { groupPerServer: true, silentWarnings: true, remindHours: 2 } });
    const tgs = app.get(TelegramService);
    const key = 'server:glue-after-warning';
    const warn = await openIncident('mem_high', 'warn');
    await tgs.dispatch({
      event: 'incident_warn',
      kind: 'mem_high',
      incidentId: warn.id,
      serverKey: key,
      title: 'Память на пределе',
    });
    expect(tg.sent().at(-1)?.body.disable_notification).toBe(true);
    const warnId = tg.ids.at(-1);

    // Через несколько минут сервер завис: критичное нельзя глушить тем, что раньше было тихое предупреждение.
    const crit = await openIncident('node_down', 'crit');
    await tgs.dispatch({
      event: 'incident_crit',
      kind: 'node_down',
      incidentId: crit.id,
      serverKey: key,
      title: 'Нода не на связи',
    });
    const loud = tg.sent().at(-1);
    const critId = tg.ids.at(-1);
    expect(loud?.body.disable_notification).toBeUndefined();
    expect(loud?.body.reply_parameters).toMatchObject({ message_id: warnId });

    // Следующий критичный того же сервера — уже одна беда с первым критичным: ответом на него и без звука.
    const second = await openIncident('server_down', 'crit');
    await tgs.dispatch({
      event: 'incident_crit',
      kind: 'server_down',
      incidentId: second.id,
      serverKey: key,
      title: 'TCP-порт недоступен',
    });
    expect(tg.sent().at(-1)?.body.disable_notification).toBe(true);
    expect(tg.sent().at(-1)?.body.reply_parameters).toMatchObject({ message_id: critId });

    // Два сбоя одного сервера отпущены разом (после перезапуска панели, по общему сроку ожидания): они не
    // должны разминуться — звук один, второй уходит ответом на первый.
    await app.get<Db>(DB).execute(sql`update incidents set status = 'resolved' where status <> 'resolved'`);
    const one = await openIncident('node_down', 'crit');
    const two = await openIncident('server_down', 'crit');
    const before = tg.sent().length;
    await Promise.all(
      [one, two].map((row) =>
        tgs.dispatch({
          event: 'incident_crit',
          kind: row.kind as 'node_down' | 'server_down',
          incidentId: row.id,
          serverKey: 'server:released-together',
          title: row.kind,
        }),
      ),
    );
    const pair = tg.sent().slice(before);
    expect(pair.map((m) => m.body.disable_notification ?? false).sort()).toEqual([false, true]);
    expect(pair.filter((m) => m.body.reply_parameters)).toHaveLength(1);
  });

  it('ночью текущая критичная тревога и вход приходят сразу, предупреждение — в сводку', async () => {
    await fresh({ quiet: quietAround('Europe/Moscow') });
    const tgs = app.get(TelegramService);
    const before = tg.sent().length;
    await tgs.dispatch({ event: 'incident_crit', kind: 'node_down', title: 'Нода недоступна' });
    await tgs.dispatch({ event: 'login', title: 'Вход с нового устройства' });
    expect(tg.sent().length).toBe(before + 2);
    expect(await digest()).toEqual([]);
    await tgs.dispatch({ event: 'incident_warn', kind: 'cpu_high', title: 'Нагрузка CPU' });
    expect(tg.sent().length).toBe(before + 2);
    expect((await digest()).map((d) => d.event)).toEqual(['incident_warn']);
    await put({ quiet: QUIET_OFF });
  });

  it('устаревшие события и виды инцидентов не отправляются даже при включённых старых тумблерах', async () => {
    await fresh();
    const tgs = app.get(TelegramService);
    const before = tg.sent().length;
    for (const event of [
      'needs_confirm',
      'autofix_started',
      'fix_failed',
      'maintenance',
      'check_failed',
      'jarvis_card',
    ] as const)
      await tgs.dispatch({ event, title: 'Историческое событие' });
    for (const kind of ['agent_offline', 'ssh_down', 'disk_high'] as const)
      await tgs.dispatch({ event: 'incident_crit', kind, title: 'Исторический вид' });
    expect(tg.sent().length).toBe(before);
    expect(await digest()).toEqual([]);
    expect(await outboxCount()).toBe(0);
  });

  it('тихие часы считаются по поясу панели, и настройки говорят, по какому поясу они работают', async () => {
    await fresh();
    const tgs = app.get(TelegramService);
    const db = app.get<Db>(DB);
    // Пояс панели — UTC; «Уведомления» в последний раз сохраняли из браузера в Омске (UTC+6).
    await app.get(SettingsService).updateAppearance({ timeZone: 'UTC' });
    const saved = telegramSettingsSchema.parse(
      (await put({ quiet: { ...quietAround('UTC'), timeZone: 'Asia/Omsk' } })).body,
    );
    expect(saved).toMatchObject({ timeZone: 'UTC', timeZoneChosen: true });

    // По часам панели сейчас тихие часы (по омским — нет): предупреждение ждёт утра.
    let before = tg.sent().length;
    await tgs.dispatch({ event: 'incident_warn', title: 'Память на пределе' });
    expect(tg.sent().length).toBe(before);
    expect((await digest()).map((d) => d.title)).toEqual(['Память на пределе']);
    // Сводка тоже не уходит, пока по поясу панели тихие часы не кончились.
    await tgs.flushDigest();
    expect(tg.sent().length).toBe(before);

    // Пояс панели не выбран — работает запасной, пояс браузера из «Уведомлений»; настройки так и говорят.
    await db.execute(sql`delete from app_meta where key = 'settings.appearance'`);
    const fallback = telegramSettingsSchema.parse(
      (await agent.get('/api/settings/telegram').expect(200)).body,
    );
    expect(fallback).toMatchObject({ timeZone: 'Asia/Omsk', timeZoneChosen: false });
    before = tg.sent().length;
    await tgs.dispatch({ event: 'incident_warn', title: 'Диск заполняется' });
    expect(tg.sent().length).toBe(before + 1);
    await put({ quiet: QUIET_OFF });
    await db.execute(sql`delete from app_meta where key = 'telegram.digest'`);
  });

  it('сбои доставки видны владельцу: отметка у чата, после трёх неудач подряд — одно предупреждение в колокольчик и запись в Журнале', async () => {
    const goodId = await fresh();
    const db = app.get<Db>(DB);
    const tgs = app.get(TelegramService);
    const since = new Date();
    await db.execute(sql`truncate notifications`);
    const chats = telegramSettingsSchema.parse(
      (
        await put({
          destinations: [
            { id: goodId },
            { url: `tgram://${TOKEN}/-100999` },
            { url: `tgram://${TOKEN}/-1009991` },
          ],
        })
      ).body,
    );
    const idOf = (chatId: string) => chats.destinations.find((d) => d.chatId === chatId)?.id ?? '';
    const badId = idOf('-100999');
    expect(chats.destinations.map((d) => d.lastDelivery)).toEqual([null, null, null]);
    const bell = async () =>
      (await app.get(NotificationsRepository).list()).items.filter(
        (n) => n.title === 'Сообщения в Telegram не доходят',
      );
    const send = (n: number) => tgs.dispatch({ event: 'login', title: `Проверка доставки ${n}` });
    const retryNow = async () => {
      await db.execute(sql`update telegram_outbox set next_attempt_at = now() - interval '1 second'`);
      await tgs.retryOutbox();
    };

    await send(1);
    await send(2);
    const after2 = telegramSettingsSchema.parse((await agent.get('/api/settings/telegram').expect(200)).body);
    const bad2 = after2.destinations.find((d) => d.id === badId);
    expect(bad2?.lastDelivery).toMatchObject({ ok: false });
    expect(bad2?.lastDelivery?.detail).toContain('Чат не найден');
    // Тест этого чата не отправляли — его отметка пуста, зелёной «тест доставлен» быть не может.
    expect(bad2?.lastTest).toBeNull();
    expect(after2.destinations.find((d) => d.id === goodId)?.lastDelivery).toMatchObject({
      ok: true,
      detail: 'Доставлено',
    });
    expect(await bell()).toHaveLength(0);

    // Новые вести уже не обгоняют первую: они лежат следом в outbox. Три настоящие попытки доставки
    // первой вести дают одно предупреждение на оба чата; следующие в те же сутки второго не создают.
    await send(3);
    await retryNow();
    await retryNow();
    const warned = await bell();
    expect(warned).toHaveLength(1);
    expect(warned[0]?.severity).toBe('warn');
    expect(warned[0]?.body).toContain('В чат с номером -100999 не доставлено 3 сообщения подряд.');
    expect(warned[0]?.body).toContain('В чат с номером -1009991 не доставлено 3 сообщения подряд.');
    expect(warned[0]?.body).toContain('Причина: Чат не найден');
    expect(warned[0]?.body).toContain('в эти чаты тревоги не приходят');
    expect(warned[0]).toMatchObject({ linkTo: '/settings/notifications', linkLabel: 'Открыть уведомления' });
    await send(4);
    expect(await bell()).toHaveLength(1);
    const logged = await journal('settings.telegram.delivery_failed', since);
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({ result: 'failed', source: 'auto', actorType: 'system' });
    expect(JSON.stringify(logged)).toContain('Чат не найден');
    expect(JSON.stringify(logged)).not.toContain(TOKEN);

    // Позже сломался ещё один чат — о нём своё предупреждение: вчерашнее про другие чаты его не заслоняет.
    await db.execute(sql`delete from telegram_outbox`);
    await put({
      destinations: [...chats.destinations.map((d) => ({ id: d.id })), { url: `tgram://${TOKEN}/-1009992` }],
    });
    for (const n of [5, 6, 7]) await send(n);
    await retryNow();
    await retryNow();
    const later = await bell();
    expect(later).toHaveLength(2);
    expect(later[0]?.body).toBe(
      'В чат с номером -1009992 не доставлено 3 сообщения подряд. Причина: Чат не найден: добавьте бота в группу или проверьте id чата. Пока это не исправлено, в этот чат тревоги не приходят.',
    );

    // Ручной тест исправного чата отметку настоящей доставки не трогает — это разные отметки.
    await agent.post('/api/settings/telegram/test').set(CSRF_HEADER, csrf).send({ id: goodId }).expect(200);
    const tested = telegramSettingsSchema.parse((await agent.get('/api/settings/telegram').expect(200)).body);
    expect(tested.destinations.find((d) => d.id === goodId)).toMatchObject({
      lastTest: { ok: true },
      lastDelivery: { ok: true },
    });
  });

  describe('расширенное оформление', () => {
    type Block = {
      type: string;
      text?: unknown;
      cells?: Array<Array<{ text: unknown; is_header?: boolean }>>;
    };
    const blocksOf = (c: { body: Record<string, unknown> } | undefined) =>
      ((c?.body.rich_message as { blocks?: Block[] } | undefined)?.blocks ?? []) as Block[];
    const RICH_ON = { groupPerServer: false, silentWarnings: true, remindHours: 2, rich: true };
    const BODY =
      'Онлайн: 300 → 10 (−97 %) за 3 минуты\n\nИз России:\n• Мост — порт отвечает\n• Германия-1 — порт не отвечает';

    it('по умолчанию выключено: сообщения уходят как раньше', async () => {
      const id = await fresh();
      expect(id).not.toBe('');
      const s = telegramSettingsSchema.parse((await agent.get('/api/settings/telegram').expect(200)).body);
      expect(s.delivery.rich).toBe(false);
      const rich = tg.rich().length;
      await app
        .get(TelegramService)
        .dispatch({ event: 'incident_warn', title: 'Память на пределе', body: BODY });
      expect(tg.rich().length).toBe(rich);
      expect(textOf(tg.sent().at(-1))).toContain('Память на пределе');
    });

    it('включено: инцидент уходит блоками — заголовок, сервер, таблица проверок; обычного сообщения нет', async () => {
      tg.richMode = 'ok';
      await fresh({ delivery: RICH_ON });
      const sent = tg.sent().length;
      await app.get(TelegramService).dispatch({
        event: 'incident_crit',
        title: 'Резко упал онлайн · tg-host',
        body: BODY,
        server: { name: 'tg-host', host: '198.51.100.7' },
      });
      expect(tg.sent().length).toBe(sent);
      const call = tg.rich().at(-1);
      expect(call?.body).not.toHaveProperty('parse_mode');
      expect(call?.body.rich_message).toMatchObject({ skip_entity_detection: true });
      const blocks = blocksOf(call);
      expect(blocks[0]).toEqual({ type: 'heading', size: 3, text: '🔴 Резко упал онлайн' });
      const table = blocks.find((b) => b.type === 'table');
      expect(table?.cells?.[0]?.map((c) => c.text)).toEqual(['Откуда', 'Результат']);
      expect(table?.cells?.slice(1).map((r) => r.map((c) => c.text))).toEqual([
        ['Мост', 'порт отвечает'],
        ['Германия-1', 'порт не отвечает'],
      ]);
      expect(blocks.at(-1)?.type).toBe('footer');
    });

    it('биллинг тоже уходит rich таблицей, а готовый HTML остаётся запасным вариантом', async () => {
      tg.richMode = 'ok';
      await fresh({ delivery: RICH_ON });
      const input = {
        state: 'soon' as const,
        kind: 'server' as const,
        title: 'DE-1 Falkenstein',
        provider: 'Hetzner',
        domain: null,
        amountMinor: 451,
        currency: 'EUR' as const,
        amountRubMinor: 46_800,
        periodUnit: 'month' as const,
        periodCount: 1,
        paidUntil: new Date('2026-10-05T09:00:00Z'),
        servers: [{ name: 'DE-1', down: false }],
        note: null,
        now: new Date('2026-10-03T09:00:00Z'),
        timeZone: 'Asia/Omsk',
      };
      const plainBefore = tg.sent().length;
      await app.get(TelegramService).dispatch({
        event: 'billing_soon',
        title: 'Скоро оплата: DE-1 Falkenstein',
        html: formatBillingMessage(input),
        rich: formatBillingRichMessage(input),
      });
      expect(tg.sent()).toHaveLength(plainBefore);
      const blocks = blocksOf(tg.rich().at(-1));
      expect(blocks[0]).toMatchObject({ type: 'heading', text: '💳 Скоро оплата — через 2 дня' });
      const table = blocks.find((block) => block.type === 'table');
      expect(table?.cells?.map((row) => row[0]?.text)).toEqual(['Сумма', 'Оплатить до', 'Период', 'Сервер']);
    });

    it('Telegram не знает метода (старый сервер) — то же сообщение сразу обычным; час в этот чат — сразу обычным', async () => {
      tg.richMode = 'old-server';
      await fresh({ delivery: RICH_ON });
      const tgs = app.get(TelegramService);
      const rich = tg.rich().length;
      const sent = tg.sent().length;
      await tgs.dispatch({ event: 'incident_warn', title: 'Диск заполняется', body: BODY });
      expect(tg.rich().length).toBe(rich + 1);
      expect(tg.sent().length).toBe(sent + 1);
      expect(textOf(tg.sent().at(-1))).toContain('Диск заполняется');
      const s = telegramSettingsSchema.parse((await agent.get('/api/settings/telegram').expect(200)).body);
      expect(s.destinations[0]?.lastDelivery).toMatchObject({
        ok: true,
        detail: 'Доставлено обычным сообщением: Telegram не принял расширенное оформление',
      });
      // Следующее — без лишней попытки: тревога не ждёт заведомого отказа.
      await tgs.dispatch({ event: 'incident_warn', title: 'Ещё одно', body: BODY });
      expect(tg.rich().length).toBe(rich + 1);
      expect(tg.sent().length).toBe(sent + 2);
      tg.richMode = 'ok';
    });

    it('разметку не приняли — обычным сообщением; связь оборвалась — второй раз не шлём, чтобы не пришло дважды', async () => {
      tg.richMode = 'bad-markup';
      await fresh({ delivery: RICH_ON });
      const tgs = app.get(TelegramService);
      // Отказ этого чата из прошлого теста забыт: чат сохранён заново.
      (tgs as unknown as { richRejectedAt: Map<string, number> }).richRejectedAt.clear();
      let sent = tg.sent().length;
      await tgs.dispatch({ event: 'incident_warn', title: 'Разметка', body: BODY });
      expect(tg.sent().length).toBe(sent + 1);

      tg.richMode = 'network';
      (tgs as unknown as { richRejectedAt: Map<string, number> }).richRejectedAt.clear();
      sent = tg.sent().length;
      const rich = tg.rich().length;
      await tgs.dispatch({ event: 'incident_warn', title: 'Обрыв', body: BODY });
      expect(tg.rich().length).toBe(rich + 1);
      expect(tg.sent().length).toBe(sent);
      tg.richMode = 'ok';
    });

    it('«Отправить тест» с включённым переключателем: образец блоками; отказ Telegram назван словами', async () => {
      tg.richMode = 'ok';
      const id = await fresh();
      const test = (rich: boolean) =>
        agent.post('/api/settings/telegram/test').set(CSRF_HEADER, csrf).send({ id, rich }).expect(200);
      const ok = (await test(true)).body as { ok: boolean; detail: string };
      expect(ok).toMatchObject({ ok: true });
      expect(ok.detail).toBe(
        'Тест доставлен в расширенном оформлении — если в чате видна таблица, его можно включать',
      );
      const sample = blocksOf(tg.rich().at(-1));
      expect(sample.some((b) => b.type === 'table')).toBe(true);

      tg.richMode = 'old-server';
      const plain = (await test(true)).body as { ok: boolean; detail: string };
      expect(plain.ok).toBe(true);
      expect(plain.detail).toMatch(
        /^Тест доставлен обычным сообщением: расширенное оформление Telegram не принял \(/,
      );
      // Тест пробует заново даже после недавнего отказа — иначе владелец не увидел бы, что Telegram обновился.
      const rich = tg.rich().length;
      tg.richMode = 'ok';
      await test(true);
      expect(tg.rich().length).toBe(rich + 1);
      // Переключатель выключен — обычный тест, как раньше.
      const before = tg.rich().length;
      expect(((await test(false)).body as { detail: string }).detail).toBe('Тест доставлен');
      expect(tg.rich().length).toBe(before);
    });
  });

  it('обрыв Telegram: сообщение остаётся в адресной очереди и после восстановления уходит один раз', async () => {
    await fresh();
    const tgs = app.get(TelegramService);
    const deliveredBefore = tg.ids.length;
    tg.networkDown = true;
    await tgs.dispatch({ event: 'login', title: 'Не потерять после обрыва' });
    expect(tg.ids).toHaveLength(deliveredBefore);
    expect(await outboxCount()).toBe(1);

    tg.networkDown = false;
    await app
      .get<Db>(DB)
      .execute(sql`update telegram_outbox set next_attempt_at = now() - interval '1 second'`);
    expect(await tgs.retryOutbox()).toBe(1);
    expect(tg.ids).toHaveLength(deliveredBefore + 1);
    expect(await outboxCount()).toBe(0);
    expect(await tgs.retryOutbox()).toBe(0);
    expect(tg.ids).toHaveLength(deliveredBefore + 1);
  });

  it('после восстановления Telegram не присылает запоздалую тревогу уже закрытого инцидента', async () => {
    await fresh();
    const tgs = app.get(TelegramService);
    const incident = await openIncident('server_down', 'crit');
    const deliveredBefore = tg.ids.length;
    tg.networkDown = true;
    await tgs.dispatch({
      event: 'incident_crit',
      kind: 'server_down',
      incidentId: incident.id,
      serverKey: serverId,
      title: 'Сервер недоступен',
    });
    expect(await outboxCount()).toBe(1);

    await app.get(IncidentsRepository).update(incident.id, {
      status: 'resolved',
      resolvedAt: new Date(),
      resolvedBy: 'auto',
    });
    tg.networkDown = false;
    await app
      .get<Db>(DB)
      .execute(sql`update telegram_outbox set next_attempt_at = now() - interval '1 second'`);

    expect(await tgs.retryOutbox()).toBe(0);
    expect(await outboxCount()).toBe(0);
    expect(tg.ids).toHaveLength(deliveredBefore);
  });

  it('ответ 429 откладывает адресную очередь ровно на retry_after Telegram', async () => {
    await fresh();
    const tgs = app.get(TelegramService);
    tg.retryAfterSeconds = 137;
    const before = Date.now();
    await tgs.dispatch({ event: 'login', title: 'Дождаться разрешения Telegram' });
    const queued = await app
      .get<Db>(DB)
      .execute<{ next_attempt_at: string }>(sql`select next_attempt_at from telegram_outbox limit 1`);
    const next = new Date(queued.rows[0]?.next_attempt_at ?? 0).getTime();
    expect(next).toBeGreaterThanOrEqual(before + 137_000);
    expect(next).toBeLessThanOrEqual(Date.now() + 137_500);
  });

  it('массовые события одного чата отправляются по очереди с заданным темпом', async () => {
    await fresh({
      delivery: { groupPerServer: false, silentWarnings: true, remindHours: 2, rich: false },
    });
    const tgs = app.get(TelegramService);
    tgs.deliveryPaceMs = 25;
    const before = tg.sent().length;
    try {
      await Promise.all([
        tgs.dispatch({ event: 'login', title: 'Массовое событие 1' }),
        tgs.dispatch({ event: 'login', title: 'Массовое событие 2' }),
        tgs.dispatch({ event: 'login', title: 'Массовое событие 3' }),
      ]);
    } finally {
      tgs.deliveryPaceMs = 0;
    }
    const sent = tg.sent().slice(before);
    expect(sent.map((call) => textOf(call))).toEqual([
      expect.stringContaining('Массовое событие 1'),
      expect.stringContaining('Массовое событие 2'),
      expect.stringContaining('Массовое событие 3'),
    ]);
    expect((sent[1]?.at ?? 0) - (sent[0]?.at ?? 0)).toBeGreaterThanOrEqual(20);
    expect((sent[2]?.at ?? 0) - (sent[1]?.at ?? 0)).toBeGreaterThanOrEqual(20);
  });

  it('обрыв при утренней сводке не теряет накопленное за тихие часы', async () => {
    await fresh();
    const tgs = app.get(TelegramService);
    await app.get(TelegramSettingsStore).addToDigest({
      event: 'incident_warn',
      title: 'Ночная проверка',
      at: new Date().toISOString(),
    });
    const deliveredBefore = tg.ids.length;
    tg.networkDown = true;
    await tgs.flushDigest();
    expect(await digest()).toEqual([]);
    expect(await outboxCount()).toBe(1);

    tg.networkDown = false;
    await app
      .get<Db>(DB)
      .execute(sql`update telegram_outbox set next_attempt_at = now() - interval '1 second'`);
    expect(await tgs.retryOutbox()).toBe(1);
    expect(tg.ids).toHaveLength(deliveredBefore + 1);
    expect(textOf(tg.sent().at(-1))).toContain('Ночная проверка');
    expect(await outboxCount()).toBe(0);
  });

  it('очередь одного чата сохраняет порядок: следующая весть не обгоняет недоставленную тревогу', async () => {
    await fresh();
    const tgs = app.get(TelegramService);
    tg.networkDown = true;
    await tgs.dispatch({ event: 'login', title: 'Первая тревога' });
    await tgs.dispatch({ event: 'login', title: 'Вторая весть' });
    expect(await outboxCount()).toBe(2);

    tg.networkDown = false;
    tg.sendFailuresRemaining = 1;
    const attemptsBefore = tg.calls.length;
    await app
      .get<Db>(DB)
      .execute(sql`update telegram_outbox set next_attempt_at = now() - interval '1 second'`);
    expect(await tgs.retryOutbox()).toBe(0);
    // После повторной неудачи первой записи вторая даже не отправляется.
    expect(tg.calls).toHaveLength(attemptsBefore + 1);
    expect(await outboxCount()).toBe(2);

    await app
      .get<Db>(DB)
      .execute(sql`update telegram_outbox set next_attempt_at = now() - interval '1 second'`);
    expect(await tgs.retryOutbox()).toBe(2);
    const delivered = tg
      .sent()
      .slice(-2)
      .map((call) => String(call.body.text));
    expect(delivered[0]).toContain('Первая тревога');
    expect(delivered[1]).toContain('Вторая весть');
    expect(await outboxCount()).toBe(0);
  });

  it('группа стала супергруппой: номер чата обновляется сам, сообщение доходит со второй попытки', async () => {
    await fresh();
    const tgs = app.get(TelegramService);
    const since = new Date();
    const moved = telegramSettingsSchema.parse(
      (await put({ destinations: [{ url: `tgram://${TOKEN}/${OLD_GROUP}` }] })).body,
    );
    expect(moved.destinations[0]?.chatId).toBe(OLD_GROUP);
    const before = tg.sent().length;
    await tgs.dispatch({ event: 'login', title: 'После переезда группы' });
    const calls = tg.sent().slice(before);
    expect(calls.map((c) => c.body.chat_id)).toEqual([OLD_GROUP, NEW_GROUP]);
    expect(textOf(calls[1])).toContain('После переезда группы');
    const after = telegramSettingsSchema.parse((await agent.get('/api/settings/telegram').expect(200)).body);
    expect(after.destinations[0]).toMatchObject({
      chatId: NEW_GROUP,
      masked: `tgram://***/${NEW_GROUP}`,
      lastDelivery: { ok: true },
    });
    // Дальше — сразу по новому номеру, без лишней попытки.
    await tgs.dispatch({ event: 'login', title: 'Ещё одно' });
    expect(tg.sent().at(-1)?.body.chat_id).toBe(NEW_GROUP);
    expect(tg.sent().length).toBe(before + 3);
    expect(await journal('settings.telegram.chat_migrated', since)).toHaveLength(1);
  });

  it('историческая отложенная тревога агента после обновления не отправляется', async () => {
    await fresh();
    const row = await app.get(IncidentsRepository).open({
      serverId,
      serverName: 'tg-host',
      kind: 'agent_offline',
      severity: 'crit',
      title: 'Старый агент',
      detail: 'История',
      timeline: [],
    });
    if (!row) throw new Error('инцидент не открылся');
    await app.get(NotificationsRepository).deferTelegram(row.id, {
      event: 'incident_crit',
      kind: 'agent_offline',
      incidentId: row.id,
      title: 'Старый агент',
    });
    const before = tg.sent().length;
    await app
      .get<Db>(DB)
      .execute(
        sql`update telegram_pending set created_at=now()-interval '10 minutes' where incident_id=${row.id}`,
      );
    await app.get(NotificationsService).flushDeferred();
    await app.get(NotificationsService).settle();
    expect(tg.sent().length).toBe(before);
    expect(await pendingCount()).toBe(0);
    expect(await outboxCount()).toBe(0);
  });

  it('отложенное сообщение переживает перезапуск панели: признак в базе, после старта оно уходит само', async () => {
    await fresh();
    const db = app.get<Db>(DB);
    const notes = app.get(NotificationsService);
    const tgs = app.get(TelegramService);
    notes.analysisWaitMs = 60_000;
    const waiting = async (kind: 'cpu_high' | 'server_down' | 'node_down', body: string) => {
      const row = await openIncident(kind, 'crit');
      await notes.push({
        severity: 'crit',
        title: `${kind} · {server}`,
        body,
        server: { id: serverId, name: 'tg-host', host: '127.0.0.1' },
        telegram: { event: 'incident_crit', incidentId: row.id, kind, awaitAnalysis: true },
      });
      return row;
    };
    const before = tg.sent().length;
    const expired = await waiting('cpu_high', 'Сервер не отвечает.');
    const analysed = await waiting('server_down', 'TCP-порт не отвечает.');
    const fresh1 = await waiting('node_down', 'Remnawave не видит ноду.');
    // Событие того же дела, возникшее, пока тревога ждёт разбора, встаёт за ней в очередь — тоже в базе.
    await notes.push({
      severity: 'crit',
      title: 'server_down · {server}: нужно вмешательство',
      body: 'Повторить TCP-проверку вручную.',
      server: { id: serverId, name: 'tg-host' },
      telegram: { event: 'incident_warn', incidentId: analysed.id, kind: 'server_down' },
    });
    await notes.settle();
    expect(tg.sent().length).toBe(before);
    // Признак «ждёт отправки» лежит в базе, а не только в памяти процесса.
    expect(await pendingCount()).toBe(3);
    // Пока сообщение ждёт — напоминать не о чем.
    expect(await tgs.lastMessageAt(expired.id)).toBeNull();

    // Панель перезапустили. Первое дело ждало дольше положенного, у второго разбор за это время закончился,
    // третье открыто только что — его разбор ещё впереди.
    await db.execute(
      sql`update telegram_pending set created_at = now() - interval '10 minutes' where incident_id = ${expired.id}`,
    );
    await db.execute(
      sql`update incidents set analysis = ${JSON.stringify({
        status: 'done',
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        steps: [],
        verdict: 'TCP-соединение отклонено.',
        confidence: 'high',
        evidence: [],
        unknown: null,
        nextAction: null,
        basedOn: { attempts: 0, resolved: false },
        model: 'm',
        error: null,
        thread: [],
      })}::jsonb where id = ${analysed.id}`,
    );
    await notes.flushDeferred();
    await notes.settle();
    const sent = tg.sent().slice(before);
    const texts = sent.map(textOf);
    expect(texts).toHaveLength(3);
    expect(texts.some((t) => t.includes('Сервер не отвечает.') && !t.includes('Разбор Джарвиса'))).toBe(true);
    const verdictAt = texts.findIndex(
      (t) =>
        t.includes('🤖 Разбор Джарвиса (уверенность высокая):') &&
        t.includes('TCP-соединение отклонено.') &&
        t.includes('TCP-порт не отвечает.'),
    );
    expect(verdictAt).toBeGreaterThanOrEqual(0);
    // Событие из очереди уходит сразу за своей тревогой — ответом на неё, а не раньше.
    const followAt = texts.findIndex((t) => t.includes('нужно вмешательство'));
    expect(followAt).toBeGreaterThan(verdictAt);
    const ids = tg.ids.slice(-texts.length);
    expect(sent[followAt]?.body.reply_parameters).toMatchObject({ message_id: ids[verdictAt] });
    expect(await pendingCount()).toBe(1);
    // Сообщение ушло — теперь по делу есть от чего отсчитывать напоминания.
    expect(await tgs.lastMessageAt(expired.id)).not.toBeNull();

    // Дело удалили — ждать отправки больше нечему.
    await agent.delete(`/api/incidents/${fresh1.id}`).set(CSRF_HEADER, csrf).expect(204);
    expect(await pendingCount()).toBe(0);
    await notes.flushDeferred();
    await notes.settle();
    expect(tg.sent().length).toBe(before + 3);
  });
});
