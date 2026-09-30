import type { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import {
  billingExtendResponseSchema,
  billingForecastSchema,
  billingItemSchema,
  billingItemsResponseSchema,
  billingPaymentsResponseSchema,
  billingStatsSchema,
  billingSummarySchema,
  CSRF_HEADER,
  fleetStatsSchema,
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
import { BillingService } from '../src/modules/billing/billing.service.js';
import { BillingRatesService } from '../src/modules/billing/billing-rates.service.js';
import { BILLING_RATES_SOURCE } from '../src/modules/billing/billing-rates.source.js';
import { TELEGRAM_CLIENT, type TelegramCall } from '../src/modules/notifications/telegram/telegram.client.js';

if (!process.env.DATABASE_URL?.endsWith('/nodeservice_test'))
  throw new Error('e2e: DATABASE_URL должен указывать на nodeservice_test');

const TOKEN = '123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw';

class FakeRates {
  calls: string[] = [];
  down = false;
  async fetch(date: string) {
    this.calls.push(date);
    if (this.down) return null;
    return { usd: 80, eur: 100, date };
  }
}

class FakeTelegram {
  sent: Array<Record<string, unknown>> = [];
  async call<T>(_t: string, method: string, body: Record<string, unknown>): Promise<TelegramCall<T>> {
    if (method === 'sendMessage') this.sent.push(body);
    if (method === 'getMe') return { ok: true, result: { username: 'bot' } as T };
    if (method === 'getChat') return { ok: true, result: { title: 'чат', type: 'private' } as T };
    return { ok: true, result: { message_id: this.sent.length } as T };
  }
}

describe('billing e2e', () => {
  let app: INestApplication;
  let agent: InstanceType<typeof TestAgent>;
  let csrf: string;
  let db: Db;
  const rates = new FakeRates();
  const tg = new FakeTelegram();
  let serverId = '';
  let providerId = '';

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(BILLING_RATES_SOURCE)
      .useValue(rates)
      .overrideProvider(TELEGRAM_CLIENT)
      .useValue(tg)
      .compile();
    app = moduleRef.createNestApplication<NestExpressApplication>({ bufferLogs: false, logger: false });
    setupHttp(app as NestExpressApplication);
    db = app.get<Db>(DB);
    await runMigrations(db);
    await db.execute(
      sql`truncate users, recovery_codes, trusted_devices, setup_tokens, servers, incidents, providers, billing_items, billing_rates cascade`,
    );
    await db.execute(sql`delete from app_meta where key like 'settings.%' or key like 'telegram.%'`);
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
    const s = await db.execute<{ id: string }>(
      sql`insert into servers (name, host, ssh_user) values ('DE-1', '10.0.0.1', 'root') returning id`,
    );
    serverId = s.rows[0]?.id ?? '';
    const p = await db.execute<{ id: string }>(
      sql`insert into providers (name, site_url) values ('Hetzner', 'https://hetzner.com') returning id`,
    );
    providerId = p.rows[0]?.id ?? '';
    await agent
      .put('/api/settings/telegram')
      .set(CSRF_HEADER, csrf)
      .send({ destinations: [{ url: `tgram://${TOKEN}/12345` }] })
      .expect(200);
  }, 60_000);

  afterAll(async () => {
    await app?.close();
  });

  const body = (over: Record<string, unknown> = {}) => ({
    kind: 'server',
    title: 'DE-1 Falkenstein',
    providerId,
    serverIds: [serverId],
    domain: null,
    amount: 4.51,
    currency: 'EUR',
    periodUnit: 'month',
    periodCount: 1,
    paidUntil: new Date(Date.now() + 10 * 86_400_000).toISOString(),
    autoCharge: false,
    remindDays: null,
    note: null,
    ...over,
  });
  let itemId = '';

  it('создание: сумма в центах, сегодняшние рубли, сервер необязателен', async () => {
    const res = await agent.post('/api/billing/items').set(CSRF_HEADER, csrf).send(body()).expect(201);
    const item = billingItemSchema.parse(res.body);
    itemId = item.id;
    expect(item.amountMinor).toBe(451);
    expect(item.dueState).toBe('ok');
    // Сервер необязателен даже у типа «Сервер».
    const noServer = billingItemSchema.parse(
      (
        await agent
          .post('/api/billing/items')
          .set(CSRF_HEADER, csrf)
          .send(body({ serverIds: [], title: 'Без сервера' }))
          .expect(201)
      ).body,
    );
    expect(noServer.serverIds).toEqual([]);
    await agent.delete(`/api/billing/items/${noServer.id}`).set(CSRF_HEADER, csrf).expect(204);
    const list = billingItemsResponseSchema.parse((await agent.get('/api/billing/items').expect(200)).body);
    expect(list.items).toHaveLength(1);
    expect(list.items[0]?.amountRubTodayMinor).toBe(45_100);
  });

  it('продление на период с учётом суммы: курс ЦБ фиксируется; отмена возвращает дату', async () => {
    const before = billingItemSchema.parse((await agent.get('/api/billing/items').expect(200)).body.items[0]);
    const res = await agent
      .post(`/api/billing/items/${itemId}/extend`)
      .set(CSRF_HEADER, csrf)
      .send({ period: true, count: true, amount: 5 })
      .expect(200);
    const { item, payment } = billingExtendResponseSchema.parse(res.body);
    expect(new Date(item.paidUntil).getUTCMonth()).toBe((new Date(before.paidUntil).getUTCMonth() + 1) % 12);
    expect(payment.rate).toBe(100);
    expect(payment.amountRubMinor).toBe(50_000);
    // Второе продление — на 3 дня без учёта суммы.
    const r2 = billingExtendResponseSchema.parse(
      (
        await agent
          .post(`/api/billing/items/${itemId}/extend`)
          .set(CSRF_HEADER, csrf)
          .send({ days: 3, count: false })
          .expect(200)
      ).body,
    );
    expect(r2.payment.counted).toBe(false);
    const hist = billingPaymentsResponseSchema.parse(
      (await agent.get(`/api/billing/items/${itemId}/payments`).expect(200)).body,
    );
    expect(hist.items.map((p) => p.undoable)).toEqual([true, false]);
    // Старое продление не отменить.
    await agent.delete(`/api/billing/payments/${payment.id}`).set(CSRF_HEADER, csrf).expect(409);
    const undone = billingItemSchema.parse(
      (await agent.delete(`/api/billing/payments/${r2.payment.id}`).set(CSRF_HEADER, csrf).expect(200)).body,
    );
    expect(undone.paidUntil).toBe(item.paidUntil);
    // Разовую на «период» не продлить.
    await agent
      .put(`/api/billing/items/${itemId}`)
      .set(CSRF_HEADER, csrf)
      .send(body({ periodUnit: 'once', paidUntil: item.paidUntil }))
      .expect(200);
    await agent
      .post(`/api/billing/items/${itemId}/extend`)
      .set(CSRF_HEADER, csrf)
      .send({ period: true, count: false })
      .expect(400);
    await agent
      .put(`/api/billing/items/${itemId}`)
      .set(CSRF_HEADER, csrf)
      .send(body({ paidUntil: item.paidUntil }))
      .expect(200);
  });

  it('итоги: оплачено за месяц в рублях по курсу дня; метка для карточки сервера', async () => {
    const s = billingSummarySchema.parse(
      (await agent.get('/api/billing/summary?tz=Europe/Moscow').expect(200)).body,
    );
    expect(s.month.spentRubMinor).toBe(50_000);
    expect(s.year.payments).toBe(1);
    expect(s.byServer[0]?.serverId).toBe(serverId);
    expect(s.rates.EUR).toBe(100);
    // Рядом с курсом — когда панель его получила («Обновлено 14:00» на странице биллинга).
    expect(Date.parse(s.rates.fetchedAt ?? '')).toBeGreaterThan(Date.now() - 600_000);
    const st = billingStatsSchema.parse((await agent.get('/api/billing/stats?period=year').expect(200)).body);
    expect(st.byProvider[0]).toMatchObject({ name: 'Hetzner', rubMinor: 50_000 });
    expect(st.byKind).toEqual([{ kind: 'server', rubMinor: 50_000 }]);
    expect(st.months.reduce((a, m) => a + (m.byKind.server ?? 0), 0)).toBe(50_000);
  });

  it('прогноз: ближайшие недели, 30 дней, до конца года и в год по сегодняшнему курсу', async () => {
    const f = billingForecastSchema.parse(
      (await agent.get('/api/billing/forecast?tz=Europe/Moscow').expect(200)).body,
    );
    expect(f.weeks).toHaveLength(3);
    expect(f.months).toHaveLength(7);
    expect(f.months[3]?.paidRubMinor).toBe(50_000);
    // Одна оплата €4.51 раз в месяц по курсу 100 — 451 ₽ за раз, 12 раз в год.
    expect(f.perYearRubMinor).toBe(45_100 * 12);
    expect(f.first?.title).toBe('DE-1 Falkenstein');
    expect(f.rateMissing).toBe(false);
  });

  it('ЦБ недоступен: оплата записывается, рубли досчитываются позже', async () => {
    await db.execute(sql`truncate billing_rates`);
    rates.down = true;
    const res = billingExtendResponseSchema.parse(
      (
        await agent
          .post(`/api/billing/items/${itemId}/extend`)
          .set(CSRF_HEADER, csrf)
          .send({ days: 1, count: true })
          .expect(200)
      ).body,
    );
    expect(res.payment.rate).toBe(0);
    rates.down = false;
    // ЦБ не ответил — панель не повторяет запрос каждую секунду (раньше это тормозило напоминания).
    const calls = rates.calls.length;
    expect(await app.get(BillingService).fillMissingRates()).toBe(0);
    expect(rates.calls.length).toBe(calls);
    // Прошло полчаса — пробует снова и досчитывает рубли.
    (app.get(BillingRatesService) as unknown as { failedAt: Map<string, number> }).failedAt.clear();
    expect(await app.get(BillingService).fillMissingRates()).toBe(1);
    const hist = billingPaymentsResponseSchema.parse(
      (await agent.get(`/api/billing/items/${itemId}/payments`).expect(200)).body,
    );
    expect(hist.items[0]?.amountRubMinor).toBe(45_100);
    await agent.delete(`/api/billing/payments/${res.payment.id}`).set(CSRF_HEADER, csrf).expect(200);
  });

  it('просрочено, сервер лежит: колокольчик, Telegram со звуком и подсказкой; повтор — не раньше суток', async () => {
    const svc = app.get(BillingService);
    /** Напоминание о просрочке заново, будто прошлого не было; возвращает текст сообщения в Telegram. */
    const remind = async (): Promise<string> => {
      await db.execute(
        sql`update billing_items set notified_state = null, notified_at = null where id = ${itemId}`,
      );
      const n = tg.sent.length;
      expect(await svc.runReminders()).toBe(1);
      for (let i = 0; i < 30 && tg.sent.length === n; i += 1) await new Promise((r) => setTimeout(r, 100));
      return String(tg.sent.at(-1)?.text);
    };
    await db.execute(
      sql`update billing_items set paid_until = now() - interval '1 day' where id = ${itemId}`,
    );
    // «SSH недоступен» — сервер работает, панель просто не может зайти: неоплатой это не объясняется.
    await db.execute(
      sql`insert into incidents (server_id, server_name, kind, severity, title) values (${serverId}, 'DE-1', 'ssh_down', 'crit', 'SSH недоступен')`,
    );
    const working = await remind();
    expect(working).toContain('Оплата просрочена на 1 день');
    expect(working).not.toContain('из-за неоплаты');
    // «Сервер недоступен», но само дело об оплате молчит (сбой сразу у нескольких серверов, порт с панели
    // открыт): напоминание не должно быть увереннее дела.
    await db.execute(
      sql`update incidents set kind = 'server_down', title = 'Сервер недоступен · DE-1' where server_id = ${serverId}`,
    );
    expect(await remind()).not.toContain('из-за неоплаты');
    // Дело само называет оплату — вот тогда и напоминание говорит о вероятной причине.
    await db.execute(
      sql`update incidents set title = 'Сервер недоступен — просрочена оплата · DE-1' where server_id = ${serverId}`,
    );
    // …но только для оплаты самого сервера: просроченный сертификат сервер не выключает.
    await db.execute(sql`update billing_items set kind = 'cert' where id = ${itemId}`);
    expect(await remind()).not.toContain('из-за неоплаты');
    await db.execute(sql`update billing_items set kind = 'server' where id = ${itemId}`);
    const text = await remind();
    const msg = tg.sent.at(-1);
    expect(text).toContain('Оплата просрочена на 1 день');
    expect(text).toContain('DE-1 недоступен</b> — вероятно, из-за неоплаты');
    expect(msg?.disable_notification).toBeFalsy();
    expect(await svc.runReminders()).toBe(0);
    // Дело возвращаем в «SSH недоступен»: по нему ниже считается доступность парка.
    await db.execute(
      sql`update incidents set kind = 'ssh_down', title = 'SSH недоступен' where server_id = ${serverId}`,
    );
    // Окно оплаты для текста инцидента и разбора: просрочка — фактом, срок — в поясе панели, а не штампом UTC.
    const win = await svc.paymentWindowForServer(serverId);
    expect([win.total, win.paying]).toEqual([1, 1]);
    expect(win.dueSoon).toEqual([]);
    expect(win.overdue).toHaveLength(1);
    expect(win.overdue[0]).toMatchObject({ kind: 'server', when: 'просрочено на 1 день', autoCharge: false });
    // В текст дела идёт только срок (он хранится и не должен устаревать); «просрочено на…» — отдельно.
    expect(win.overdue[0]?.text).toMatch(
      /^Сервер «DE-1 Falkenstein» у Hetzner: .+, оплачено до \d{1,2} [а-я]+( \d{4})?, \d{2}:\d{2} \((МСК|UTC[+-]\d+)\)$/,
    );
    expect(win.overdue[0]?.text).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
    // Ссылка из напоминания ведёт на страницу биллинга с окном этой оплаты (раньше — на несуществующую).
    const bell = (await agent.get('/api/notifications').expect(200)).body as {
      items: Array<{ title: string; link: { to: string } | null }>;
    };
    expect(bell.items.find((n) => n.title.startsWith('Оплата просрочена'))?.link?.to).toBe(
      `/servers/billing?item=${itemId}`,
    );
    // У сервера без оплат в «Биллинге» окно пустое, и панель это знает: total = 0.
    expect(await svc.paymentWindowForServer('00000000-0000-7000-8000-000000000000')).toEqual({
      overdue: [],
      dueSoon: [],
      autoRenewed: [],
      next: null,
      total: 0,
      paying: 0,
    });
    // К серверу привязан только сертификат: оплата есть, но срока оплаты самого сервера панель не знает.
    await db.execute(sql`update billing_items set kind = 'cert' where id = ${itemId}`);
    const certOnly = await svc.paymentWindowForServer(serverId);
    expect([certOnly.total, certOnly.paying]).toEqual([1, 0]);
    await db.execute(sql`update billing_items set kind = 'server' where id = ${itemId}`);
    const forJarvis = await svc.forAssistant();
    expect(forJarvis.items[0]).toMatchObject({
      title: 'DE-1 Falkenstein',
      provider: 'Hetzner',
      servers: ['DE-1'],
    });
  });

  it('скоро оплата — без звука, один раз; автоплатёж продлевает сам', async () => {
    const svc = app.get(BillingService);
    await db.execute(
      sql`update billing_items set paid_until = now() + interval '2 days', notified_state = null where id = ${itemId}`,
    );
    const n = tg.sent.length;
    expect(await svc.runReminders()).toBe(1);
    for (let i = 0; i < 30 && tg.sent.length === n; i += 1) await new Promise((r) => setTimeout(r, 100));
    expect(String(tg.sent.at(-1)?.text)).toContain('Скоро оплата — через 2 дня');
    expect(await svc.runReminders()).toBe(0);
    // Срок через двое суток — в окно оплаты не входит, но ближайший срок назван.
    const far = await svc.paymentWindowForServer(serverId);
    expect([far.overdue, far.dueSoon, far.autoRenewed]).toEqual([[], [], []]);
    expect(far.next).toContain('через 2 дня');
    // Срок через несколько часов — уже окно: «ещё не просрочено» неоплату не исключает.
    await db.execute(
      sql`update billing_items set paid_until = now() + interval '5 hours' where id = ${itemId}`,
    );
    const soon = await svc.paymentWindowForServer(serverId);
    expect(soon.overdue).toEqual([]);
    expect(soon.dueSoon).toHaveLength(1);
    expect(soon.dueSoon[0]?.when).toMatch(/^через (4 часа|5 часов)$/);
    expect(soon.next).toBeNull();
    await db.execute(
      sql`update billing_items set paid_until = now() - interval '1 hour', auto_charge = true where id = ${itemId}`,
    );
    expect(await svc.runAutoCharge()).toBe(1);
    const item = billingItemSchema.parse((await agent.get('/api/billing/items').expect(200)).body.items[0]);
    expect(item.dueState).not.toBe('overdue');
    // Автоплатёж продлил срок час назад: панель не знает, прошло ли списание, — это тоже окно оплаты.
    const auto = await svc.paymentWindowForServer(serverId);
    expect([auto.overdue, auto.dueSoon]).toEqual([[], []]);
    expect(auto.autoRenewed).toHaveLength(1);
    expect(auto.autoRenewed[0]).toContain('автоплатёж, срок продлён');
    expect(auto.autoRenewed[0]).toContain('прошло ли списание у провайдера, панель не знает');
  });

  it('статистика парка: доступность по инцидентам, стоимость из биллинга; без хранилища метрик — честно vmOk=false', async () => {
    // SSH-инцидент открыт 3 дня назад и не закрыт: из 30 дней сервер 3 дня не на связи — 90 %.
    await db.execute(sql`update incidents set opened_at = now() - interval '3 days' where kind = 'ssh_down'`);
    const st = fleetStatsSchema.parse((await agent.get('/api/fleet/stats?period=month').expect(200)).body);
    expect(st.servers.map((x) => x.name)).toEqual(['DE-1']);
    expect(st.availability.incidents).toBeGreaterThanOrEqual(1);
    expect(st.availability.pct).toBe(90);
    expect(st.servers[0]?.uptimePct).toBe(90);
    expect(st.incidentsByKind[0]).toMatchObject({ kind: 'ssh_down', label: expect.any(String) });
    expect(st.cost.spentRubMinor).toBeGreaterThan(0);
    if (!st.vmOk) expect(st.traffic.rxBytes).toBeNull();
    await agent.get('/api/fleet/stats?period=year').expect(400);
  });

  it('архив и удаление', async () => {
    await agent
      .post(`/api/billing/items/${itemId}/archive`)
      .set(CSRF_HEADER, csrf)
      .send({ archived: true })
      .expect(200);
    expect((await agent.get('/api/billing/items').expect(200)).body.items).toHaveLength(0);
    expect((await agent.get('/api/billing/items?archived=1').expect(200)).body.items).toHaveLength(1);
    await agent.delete(`/api/billing/items/${itemId}`).set(CSRF_HEADER, csrf).expect(204);
    await agent.delete(`/api/billing/items/${itemId}`).set(CSRF_HEADER, csrf).expect(404);
  });
});
