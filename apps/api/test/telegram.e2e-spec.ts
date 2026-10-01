import type { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import {
  CSRF_HEADER,
  notificationsResponseSchema,
  serverSchema,
  TELEGRAM_EVENTS,
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
import { IncidentsService } from '../src/modules/incidents/incidents.service.js';
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
  calls: Array<{ token: string; method: string; body: Record<string, unknown>; proxy?: string | null }> = [];
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
  async call<T>(
    token: string,
    method: string,
    body: Record<string, unknown>,
    proxy?: string | null,
  ): Promise<TelegramCall<T>> {
    this.calls.push({ token, method, body, proxy: proxy ?? null });
    if (this.networkDown && (method === 'sendMessage' || method === 'sendRichMessage'))
      throw new Error('socket hang up');
    if (this.sendFailuresRemaining > 0 && (method === 'sendMessage' || method === 'sendRichMessage')) {
      this.sendFailuresRemaining -= 1;
      throw new Error('socket hang up');
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

  const noMetrics = { cpu: new Map(), mem: new Map(), disk: new Map() };
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
    (app.get(IncidentsService) as unknown as { hostCache: Map<string, unknown> }).hostCache.clear();
    app.get(IncidentsService).recordNodeState(serverId, 'running');
    const s = telegramSettingsSchema.parse(
      (
        await put({
          destinations: [{ url: `tgram://${TOKEN}/-1002946167407` }],
          events: ALL_EVENTS,
          kinds: { ssh_down: true, agent_offline: true, disk_high: true },
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
    kind: 'agent_offline' | 'ssh_down' | 'server_down' | 'mem_high' | 'cpu_high',
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
    const crit = await openIncident('agent_offline', 'crit');
    await tgs.dispatch({
      event: 'incident_crit',
      kind: 'agent_offline',
      incidentId: crit.id,
      serverKey: key,
      title: 'Агент не в сети',
    });
    const loud = tg.sent().at(-1);
    const critId = tg.ids.at(-1);
    expect(loud?.body.disable_notification).toBeUndefined();
    expect(loud?.body.reply_parameters).toMatchObject({ message_id: warnId });

    // Следующий критичный того же сервера — уже одна беда с первым критичным: ответом на него и без звука.
    const second = await openIncident('ssh_down', 'crit');
    await tgs.dispatch({
      event: 'incident_crit',
      kind: 'ssh_down',
      incidentId: second.id,
      serverKey: key,
      title: 'SSH недоступен',
    });
    expect(tg.sent().at(-1)?.body.disable_notification).toBe(true);
    expect(tg.sent().at(-1)?.body.reply_parameters).toMatchObject({ message_id: critId });

    // Два сбоя одного сервера отпущены разом (после перезапуска панели, по общему сроку ожидания): они не
    // должны разминуться — звук один, второй уходит ответом на первый.
    await app.get<Db>(DB).execute(sql`update incidents set status = 'resolved' where status <> 'resolved'`);
    const one = await openIncident('agent_offline', 'crit');
    const two = await openIncident('ssh_down', 'crit');
    const before = tg.sent().length;
    await Promise.all(
      [one, two].map((row) =>
        tgs.dispatch({
          event: 'incident_crit',
          kind: row.kind as 'agent_offline' | 'ssh_down',
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

  it('ночью критичный инцидент с предложенным шагом и вход с нового устройства приходят сразу; остальное — в утреннюю сводку', async () => {
    await fresh({ quiet: quietAround('Europe/Moscow') });
    const svc = app.get(IncidentsService);
    const notes = app.get(NotificationsService);
    const repo = app.get(IncidentsRepository);

    // 03:10 — остановился контейнер ноды: панель сразу предлагает шаг и ждёт «Да».
    let before = tg.sent().length;
    await svc.probeNodeState(serverId, 'stopped');
    await notes.settle();
    const down = await repo.findOpen(serverId, 'node_down');
    expect(down?.proposal).toMatchObject({ action: 'node_up' });
    expect(tg.sent().length).toBe(before + 1);
    expect(textOf(tg.sent().at(-1))).toContain('ждёт подтверждения');
    expect(tg.sent().at(-1)?.body.disable_notification).toBeUndefined();
    expect(await digest()).toEqual([]);

    // Контейнер поднялся: «Починилось» не критично — ждёт утра.
    await svc.probeNodeState(serverId, 'running');
    await notes.settle();
    expect(tg.sent().length).toBe(before + 1);
    expect((await digest()).map((d) => d.event)).toEqual(['resolved']);

    // Тумблер «Нужно ваше „Да“» выключен: само открытие критичного инцидента он не глушит.
    await put({ events: { needs_confirm: false } });
    before = tg.sent().length;
    await svc.probeNodeState(serverId, 'stopped');
    await notes.settle();
    expect(tg.sent().length).toBe(before + 1);
    expect(textOf(tg.sent().at(-1))).toContain('Контейнер ноды не запущен');
    expect(tg.sent().at(-1)?.body.disable_notification).toBeUndefined();
    // А следующее «ждёт подтверждения» по тому же делу — уже не открытие: тумблер его не пропускает.
    const again = await repo.findOpen(serverId, 'node_down');
    await notes.push({
      severity: 'crit',
      title: 'Контейнер ноды не запущен · {server}: ждёт подтверждения',
      server: { id: serverId, name: 'tg-host' },
      telegram: { event: 'needs_confirm', incidentId: again?.id ?? '', kind: 'node_down' },
    });
    await notes.settle();
    expect(tg.sent().length).toBe(before + 1);
    await put({ events: { needs_confirm: true } });

    // Вход в панель с нового устройства — про безопасность: ночью сразу и со звуком.
    before = tg.sent().length;
    await notes.push({
      severity: 'info',
      title: 'Вход в панель с нового устройства',
      body: 'Вошёл «admin». IP 203.0.113.7, Chrome на Windows.',
      telegram: { event: 'login' },
    });
    await waitSent(before + 1);
    expect(textOf(tg.sent().at(-1))).toContain('Вход в панель с нового устройства');
    expect(tg.sent().at(-1)?.body.disable_notification).toBeUndefined();

    // Некритичное ночью — по-прежнему в утреннюю сводку: предупреждение, шаг по нему и «не помогло» по критичному.
    before = tg.sent().length;
    const warn = await openIncident('cpu_high', 'warn');
    await notes.push({
      severity: 'warn',
      title: 'Высокая нагрузка на CPU · {server}: ждёт подтверждения',
      server: { id: serverId, name: 'tg-host' },
      telegram: { event: 'needs_confirm', incidentId: warn.id, kind: 'cpu_high' },
    });
    // Дела разные — отправки идут независимо; дожидаемся первой, чтобы порядок строк сводки был известен.
    await notes.settle();
    await notes.push({
      severity: 'warn',
      title: 'Контейнер ноды не запущен · {server}: «Поднять контейнер ноды» — не помогло',
      server: { id: serverId, name: 'tg-host' },
      telegram: { event: 'fix_failed', incidentId: again?.id ?? '', kind: 'node_down' },
    });
    await notes.settle();
    expect(tg.sent().length).toBe(before);
    expect((await digest()).map((d) => d.event)).toEqual(['resolved', 'needs_confirm', 'fix_failed']);

    await svc.probeNodeState(serverId, 'running');
    await notes.settle();
    await put({ quiet: QUIET_OFF });
  });

  it('тумблер «Нужно ваше „Да“» выключен: открытие предупреждения с предложенным шагом приходит, но тихо — как предупреждение', async () => {
    await fresh({ events: { ...ALL_EVENTS, needs_confirm: false } });
    const notes = app.get(NotificationsService);
    const ask = async (incidentId: string) => {
      await notes.push({
        severity: 'warn',
        title: 'Высокая нагрузка на CPU · {server}: ждёт подтверждения',
        body: 'Предложено: Перезапустить контейнер ноды (T2). Подтвердите запуск в инциденте.',
        server: { id: serverId, name: 'tg-host' },
        telegram: { event: 'needs_confirm', incidentId, kind: 'cpu_high', severity: 'warn' },
      });
      await notes.settle();
    };
    const first = await openIncident('cpu_high', 'warn');
    let before = tg.sent().length;
    await ask(first.id);
    expect(tg.sent().length).toBe(before + 1);
    expect(tg.sent().at(-1)?.body.disable_notification).toBe(true);

    // С включённым тумблером — как раньше: «ждёт подтверждения» приходит со звуком.
    await put({ events: { needs_confirm: true } });
    await app.get<Db>(DB).execute(sql`update incidents set status = 'resolved' where id = ${first.id}`);
    const second = await openIncident('cpu_high', 'warn');
    before = tg.sent().length;
    await ask(second.id);
    expect(tg.sent().length).toBe(before + 1);
    expect(tg.sent().at(-1)?.body.disable_notification).toBeUndefined();
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
      notificationsResponseSchema
        .parse((await agent.get('/api/notifications').expect(200)).body)
        .items.filter((n) => n.title === 'Сообщения в Telegram не доходят');
    const send = (n: number) => tgs.dispatch({ event: 'maintenance', title: `Проверка доставки ${n}` });

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

    // Третья неудача подряд — одно предупреждение на оба чата (беда одна); четвёртая в те же сутки — второго нет.
    await send(3);
    const warned = await bell();
    expect(warned).toHaveLength(1);
    expect(warned[0]?.severity).toBe('warn');
    expect(warned[0]?.body).toContain('В чат с номером -100999 не доставлено 3 сообщения подряд.');
    expect(warned[0]?.body).toContain('В чат с номером -1009991 не доставлено 3 сообщения подряд.');
    expect(warned[0]?.body).toContain('Причина: Чат не найден');
    expect(warned[0]?.body).toContain('в эти чаты тревоги не приходят');
    expect(warned[0]?.link).toEqual({ to: '/settings/notifications', label: 'Открыть уведомления' });
    await send(4);
    expect(await bell()).toHaveLength(1);
    const logged = await journal('settings.telegram.delivery_failed', since);
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({ result: 'failed', source: 'auto', actorType: 'system' });
    expect(JSON.stringify(logged)).toContain('Чат не найден');
    expect(JSON.stringify(logged)).not.toContain(TOKEN);

    // Позже сломался ещё один чат — о нём своё предупреждение: вчерашнее про другие чаты его не заслоняет.
    await put({
      destinations: [...chats.destinations.map((d) => ({ id: d.id })), { url: `tgram://${TOKEN}/-1009992` }],
    });
    for (const n of [5, 6, 7]) await send(n);
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
    await tgs.dispatch({ event: 'maintenance', title: 'Не потерять после обрыва' });
    expect(tg.ids).toHaveLength(deliveredBefore);
    expect(await outboxCount()).toBe(1);

    tg.networkDown = false;
    await app.get<Db>(DB).execute(sql`update telegram_outbox set next_attempt_at = now()`);
    expect(await tgs.retryOutbox()).toBe(1);
    expect(tg.ids).toHaveLength(deliveredBefore + 1);
    expect(await outboxCount()).toBe(0);
    expect(await tgs.retryOutbox()).toBe(0);
    expect(tg.ids).toHaveLength(deliveredBefore + 1);
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
    await app.get<Db>(DB).execute(sql`update telegram_outbox set next_attempt_at = now()`);
    expect(await tgs.retryOutbox()).toBe(1);
    expect(tg.ids).toHaveLength(deliveredBefore + 1);
    expect(textOf(tg.sent().at(-1))).toContain('Ночная проверка');
    expect(await outboxCount()).toBe(0);
  });

  it('очередь одного чата сохраняет порядок: следующая весть не обгоняет недоставленную тревогу', async () => {
    await fresh();
    const tgs = app.get(TelegramService);
    tg.networkDown = true;
    await tgs.dispatch({ event: 'maintenance', title: 'Первая тревога' });
    await tgs.dispatch({ event: 'maintenance', title: 'Вторая весть' });
    expect(await outboxCount()).toBe(2);

    tg.networkDown = false;
    tg.sendFailuresRemaining = 1;
    const attemptsBefore = tg.calls.length;
    await app.get<Db>(DB).execute(sql`update telegram_outbox set next_attempt_at = now()`);
    expect(await tgs.retryOutbox()).toBe(0);
    // После повторной неудачи первой записи вторая даже не отправляется.
    expect(tg.calls).toHaveLength(attemptsBefore + 1);
    expect(await outboxCount()).toBe(2);

    await app.get<Db>(DB).execute(sql`update telegram_outbox set next_attempt_at = now()`);
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
    await tgs.dispatch({ event: 'maintenance', title: 'После переезда группы' });
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
    await tgs.dispatch({ event: 'maintenance', title: 'Ещё одно' });
    expect(tg.sent().at(-1)?.body.chat_id).toBe(NEW_GROUP);
    expect(tg.sent().length).toBe(before + 3);
    expect(await journal('settings.telegram.chat_migrated', since)).toHaveLength(1);
  });

  it('короткий сбой при автоматическом разборе: тревога не приходит после «Починилось» — одно тихое сообщение', async () => {
    await fresh();
    const db = app.get<Db>(DB);
    const svc = app.get(IncidentsService);
    const notes = app.get(NotificationsService);
    const repo = app.get(IncidentsRepository);
    await agent
      .put('/api/settings/assistant')
      .set(CSRF_HEADER, csrf)
      .send({
        apiKey: 'sk-test-0123456789',
        model: 'anthropic/claude-sonnet-4-5',
        permissions: { analysis: true, autoAnalysis: true },
      })
      .expect(200);
    expect(await svc.analysisWillFollow()).toBe(true);
    // В тестах ожидание разбора — 50 мс; здесь нужно, чтобы сбой закончился раньше, чем оно истечёт.
    notes.analysisWaitMs = 60_000;
    const lose = async () => {
      await db.execute(
        sql`update servers set agent_status = 'offline', ssh_ok = false where id = ${serverId}`,
      );
      await svc.evaluate(noMetrics);
      await notes.settle();
    };
    const back = async () => {
      await db.execute(sql`update servers set agent_status = 'online', ssh_ok = true where id = ${serverId}`);
      await svc.evaluate(noMetrics);
      await notes.settle();
    };

    // 14:00:00 — сервер пропал: дело открыто, колокольчик сразу, Telegram ждёт разбора Джарвиса.
    let before = tg.sent().length;
    await lose();
    const down = await repo.findOpen(serverId, 'server_down');
    expect(down).toBeTruthy();
    expect(tg.sent().length).toBe(before);
    expect(await pendingCount()).toBe(1);

    // 14:01:30 — сервер вернулся раньше, чем начался разбор: тревога отменена, приходит одно тихое сообщение.
    await back();
    expect(tg.sent().length).toBe(before + 1);
    const note = tg.sent().at(-1);
    expect(textOf(note)).toContain('✅ <b>Короткий сбой, дело уже закрыто: Сервер недоступен</b>');
    expect(textOf(note)).toContain('<b>tg-host</b>');
    expect(textOf(note)).toContain('<b>Длился с момента обнаружения:</b> меньше минуты');
    expect(textOf(note)).toContain('<b>Чем закончилось:</b> Сервер снова на связи: агент и SSH отвечают.');
    expect(note?.body.disable_notification).toBe(true);
    expect(await pendingCount()).toBe(0);

    // 14:04:00 — время ожидания вышло, разбор закончился: тревоги по закрытому делу нет.
    await notes.releaseAfterAnalysis(down?.id ?? '', 'Сервер перезагружался.', 'high');
    await notes.flushDeferred();
    await notes.settle();
    expect(tg.sent().length).toBe(before + 1);
    expect(
      tg
        .sent()
        .slice(before)
        .some((m) => textOf(m).includes('🔴')),
    ).toBe(false);

    // Лимит автоматических разборов в час исчерпан — разбора не будет, и тревога не ждёт его зря.
    svc.autoAnalysisRoom = () => 0;
    expect(await svc.analysisWillFollow()).toBe(false);
    before = tg.sent().length;
    await lose();
    expect(tg.sent().length).toBe(before + 1);
    expect(textOf(tg.sent().at(-1))).toContain('🔴 <b>Сервер недоступен</b>');
    expect(await pendingCount()).toBe(0);
    const alertId = tg.ids.at(-1);
    await back();
    // Тревога уже ушла — «Починилось» приходит обычным ответом на неё.
    expect(textOf(tg.sent().at(-1))).toContain('✅');
    expect(textOf(tg.sent().at(-1))).not.toContain('Короткий сбой');
    expect(tg.sent().at(-1)?.body.reply_parameters).toMatchObject({ message_id: alertId });
    svc.autoAnalysisRoom = () => 1;

    // Тумблер «Починилось» выключен: о коротком сбое всё равно приходит весть — она вместо тревоги и
    // проходит по её тумблеру. Выключены оба — не приходит ничего.
    await put({ events: { resolved: false } });
    before = tg.sent().length;
    await lose();
    await back();
    expect(tg.sent().length).toBe(before + 1);
    expect(textOf(tg.sent().at(-1))).toContain('Короткий сбой, дело уже закрыто: Сервер недоступен');
    expect(tg.sent().at(-1)?.body.disable_notification).toBe(true);
    await put({ events: { incident_crit: false } });
    await lose();
    await back();
    expect(tg.sent().length).toBe(before + 1);
    await put({ events: { resolved: true, incident_crit: true } });

    // Закрыли вручную в панели, пока тревога ждала разбора, — она не приходит вовсе.
    before = tg.sent().length;
    await lose();
    const manual = await repo.findOpen(serverId, 'server_down');
    expect(await pendingCount()).toBe(1);
    await agent.post(`/api/incidents/${manual?.id}/resolve`).set(CSRF_HEADER, csrf).expect(200);
    await notes.flushDeferred();
    await notes.settle();
    expect(await pendingCount()).toBe(0);
    expect(tg.sent().length).toBe(before);
    await back();
  });

  it('отложенное сообщение переживает перезапуск панели: признак в базе, после старта оно уходит само', async () => {
    await fresh();
    const db = app.get<Db>(DB);
    const notes = app.get(NotificationsService);
    const tgs = app.get(TelegramService);
    notes.analysisWaitMs = 60_000;
    const waiting = async (kind: 'server_down' | 'ssh_down' | 'agent_offline', body: string) => {
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
    const expired = await waiting('server_down', 'Сервер не отвечает.');
    const analysed = await waiting('ssh_down', 'Панель не заходит по SSH.');
    const fresh1 = await waiting('agent_offline', 'Агент молчит.');
    // Событие того же дела, возникшее, пока тревога ждёт разбора, встаёт за ней в очередь — тоже в базе.
    await notes.push({
      severity: 'crit',
      title: 'ssh_down · {server}: нужно вмешательство',
      body: 'Посмотреть журнал SSH — только вручную.',
      server: { id: serverId, name: 'tg-host' },
      telegram: { event: 'needs_confirm', incidentId: analysed.id, kind: 'ssh_down' },
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
        verdict: 'Сменился ключ SSH.',
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
        t.includes('Сменился ключ SSH.') &&
        t.includes('Панель не заходит по SSH.'),
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
