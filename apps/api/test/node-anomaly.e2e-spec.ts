import type { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { CSRF_HEADER, incidentsListResponseSchema, scenarioSchema } from '@nodeservice/shared';
import { sql } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import { generate } from 'otplib';
import request from 'supertest';
import TestAgent from 'supertest/lib/agent.js';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { setupHttp } from '../src/common/http/setup-http.js';
import { DB, type Db } from '../src/infra/db/db.module.js';
import { runMigrations } from '../src/infra/db/migrate.js';
import { VALKEY } from '../src/infra/valkey/valkey.module.js';
import { SetupService } from '../src/modules/auth/setup.service.js';
import {
  CheckHostService,
  type TcpReport,
  type TcpVerdict,
} from '../src/modules/incidents/check-host.service.js';
import { FleetMonitorJob } from '../src/modules/incidents/fleet-monitor.job.js';
import { NodeEventsStore } from '../src/modules/node-events/node-events.store.js';
import { NotificationsService } from '../src/modules/notifications/notifications.service.js';
import { RemnawaveService } from '../src/modules/remnawave/remnawave.service.js';
import { ScenariosJob } from '../src/modules/scenarios/scenarios.job.js';
import { ScenariosStore } from '../src/modules/scenarios/scenarios.store.js';
import { MonitoringStore } from '../src/modules/settings/monitoring.store.js';

if (!process.env.DATABASE_URL?.endsWith('/nodeservice_test'))
  throw new Error('e2e: нужна отдельная nodeservice_test');

/** AppModule + настоящие миграции/настройки/состояние/инциденты. Только внешние системы подменены. */
describe('Remnawave → Check-Host → persisted incidents (e2e)', () => {
  let app: INestApplication;
  let db: Db;
  let agent: InstanceType<typeof TestAgent>;
  let job: FleetMonitorJob;
  let settings: MonitoringStore;
  let stamp: number;
  const uuid = 'e905e7c4-6928-40be-8051-7e9798b36e15';
  const node = {
    uuid,
    name: 'Нода Remnawave',
    address: '198.51.100.9',
    port: 8443,
    usersOnline: 100,
    isConnected: true,
    isDisabled: false,
    cpuCount: 4,
    loadAverage: [0.4, 0.4, 0.4],
    memoryTotalBytes: 100,
    memoryUsedBytes: 20,
  };
  const status = { connected: true, domain: 'panel.example.com', checkedAt: '', error: null, nodes: [node] };
  const remna = { status: vi.fn(async () => structuredClone(status)) };
  const notifications = { push: vi.fn().mockResolvedValue(undefined) };
  const report = (verdict: TcpVerdict): TcpReport => ({
    verdict,
    checkedAt: new Date().toISOString(),
    target: `${node.address}:5492`,
    link: 'https://check-host.net/check-report/test',
    observations: [],
    error: null,
  });
  const tcp = { checkNode: vi.fn() };
  const list = async (state = 'open') =>
    incidentsListResponseSchema.parse((await agent.get(`/api/incidents?status=${state}`).expect(200)).body)
      .items;
  const snapshot = async (online = node.usersOnline) => {
    node.usersOnline = online;
    stamp += 1000;
    status.checkedAt = new Date(stamp).toISOString();
    await job.run();
    // verifyDrop completes asynchronously after the persisted state write.
    await vi.waitFor(() => expect((job as unknown as { verifying: Set<string> }).verifying.size).toBe(0));
  };
  const baseline = async () => {
    for (let i = 0; i < 3; i++) await snapshot(100);
  };
  const collapse = async () => {
    for (let i = 0; i < 3; i++) await snapshot(10);
  };

  beforeAll(async () => {
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(RemnawaveService)
      .useValue(remna)
      .overrideProvider(CheckHostService)
      .useValue(tcp)
      .overrideProvider(NotificationsService)
      .useValue(notifications)
      .compile();
    app = module.createNestApplication<NestExpressApplication>({ logger: false });
    setupHttp(app as NestExpressApplication);
    db = app.get<Db>(DB);
    await runMigrations(db);
    await db.execute(sql`truncate users, recovery_codes, trusted_devices, setup_tokens, incidents cascade`);
    await db.execute(sql`delete from app_meta where key like 'settings.%' or key like 'monitor.%'`);
    await app.get<Redis>(VALKEY).flushdb();
    await app.init();
    job = app.get(FleetMonitorJob);
    settings = app.get(MonitoringStore);
    agent = request.agent(app.getHttpServer());
    const csrf = (await agent.get('/api/auth/csrf').expect(200)).body.token;
    const start = await agent
      .post('/api/auth/setup/start')
      .set(CSRF_HEADER, csrf)
      .send({
        setupToken: await app.get(SetupService).issueToken(),
        login: 'admin',
        password: 'correct horse battery staple',
      })
      .expect(200);
    await agent
      .post('/api/auth/setup/confirm')
      .set(CSRF_HEADER, csrf)
      .send({ code: await generate({ secret: start.body.totpSecret }) })
      .expect(200);
  }, 60_000);
  afterAll(async () => {
    await app?.close();
  });
  beforeEach(async () => {
    await db.execute(sql`truncate incidents cascade`);
    await db.execute(sql`delete from app_meta where key like 'monitor.%' or key like 'settings.node-view.%'`);
    Object.assign(node, {
      address: '198.51.100.9',
      loadAverage: [0.4, 0.4, 0.4],
      memoryUsedBytes: 20,
      port: 8443,
      usersOnline: 100,
      isConnected: true,
      isDisabled: false,
    });
    Object.assign(status, { connected: true, domain: 'panel.example.com', error: null });
    stamp = Date.now();
    status.checkedAt = new Date(stamp).toISOString();
    await settings.set({
      enabled: true,
      checkHostEnabled: true,
      checkHostOnDrop: true,
      confirmSamples: 3,
      recoverySamples: 3,
    });
    tcp.checkNode.mockReset().mockImplementation(async () => report('russia_unreachable'));
    notifications.push.mockClear();
  });

  it('сценарий сохраняет И/ИЛИ и выключенное состояние через настоящий HTTP/БД', async () => {
    const csrf = (await agent.get('/api/auth/csrf').expect(200)).body.token;
    const rule = scenarioSchema.parse({
      id: '11111111-1111-4111-8111-111111111111',
      name: 'Два условия',
      scope: 'selected',
      nodes: [uuid],
      trigger: 'offline',
      conditions: ['offline', 'tcp_unreachable'],
      conditionMode: 'all',
      actions: ['check_tcp', 'record_event'],
    });
    const saved = await agent
      .put('/api/scenarios')
      .set(CSRF_HEADER, csrf)
      .send({ items: [rule] })
      .expect(200);
    expect(saved.body.items[0]).toMatchObject({
      enabled: false,
      conditionMode: 'all',
      conditions: ['offline', 'tcp_unreachable'],
    });
    expect((await agent.get('/api/scenarios').expect(200)).body.items[0]).toEqual(saved.body.items[0]);
    await agent
      .put('/api/scenarios')
      .set(CSRF_HEADER, csrf)
      .send({ items: [{ ...rule, holdMinutes: 0 }] })
      .expect(400);
    await agent
      .put('/api/scenarios')
      .set(CSRF_HEADER, csrf)
      .send({ items: [{ ...rule, nodes: ['22222222-2222-4222-8222-222222222222'] }] })
      .expect(400);
    await agent.put('/api/scenarios').set(CSRF_HEADER, csrf).send({ items: [] }).expect(200);
  });
  it('условие И: offline+TCP работает без инцидента через реальные хранилища', async () => {
    node.isConnected = false;
    status.checkedAt = new Date().toISOString();
    tcp.checkNode.mockImplementation(async () => report('port_unreachable'));
    const store = app.get(ScenariosStore),
      scope = store.scope(status.domain),
      rule = scenarioSchema.parse({
        id: '33333333-3333-4333-8333-333333333333',
        name: 'Связь и TCP',
        enabled: true,
        trigger: 'offline',
        conditions: ['offline', 'tcp_unreachable'],
        conditionMode: 'all',
        holdMinutes: 1,
        actions: ['check_tcp', 'record_event'],
      });
    await store.set(status.domain, [rule]);
    await store.write(`scenarios.state.${scope}.${rule.id}.${uuid}`, {
      since: Date.now() - 61000,
      stamp: Date.now() - 61000,
      latched: false,
      lastRun: 0,
    });
    // Проверка порта для условия идёт в фоне: первый проход её запускает, следующий снимок срабатывает по ней.
    const job = app.get(ScenariosJob);
    await job.run();
    await job.idle();
    await store.write(`scenarios.state.${scope}.${rule.id}.${uuid}`, {
      since: Date.now() - 61000,
      stamp: Date.now() - 61000,
      latched: false,
      lastRun: 0,
    });
    status.checkedAt = new Date(Date.now() + 1).toISOString();
    await job.run();
    await job.idle();
    expect(tcp.checkNode).toHaveBeenCalledTimes(1);
    const events = await app
      .get(NodeEventsStore)
      .list(status.domain, [uuid], Date.now() - 120000, Date.now() + 1000);
    expect(events.events.some((e) => e.type === 'automation' && e.title.includes('Связь и TCP'))).toBe(true);
    expect(events.events.some((e) => e.type === 'tcp_check')).toBe(true);
    expect(await list()).toHaveLength(0);
    await store.set(status.domain, []);
    await db.execute(sql`delete from app_meta where key like 'scenarios.%' or key like 'node.events.%'`);
  });
  it('общая история сохраняет факты проверок, не дублирует опрос и разделяет панели/ноды', async () => {
    const events = app.get(NodeEventsStore),
      t = Date.now();
    const event = {
      id: 'e2e:bs:result',
      t,
      nodeUuid: uuid,
      nodeName: node.name,
      type: 'bs_check' as const,
      title: 'BS завершена',
      summary: 'TCP: 2/3 доступно',
      link: '/integrations/bschecker',
    };
    await events.append(status.domain, event);
    await events.append(status.domain, event);
    await events.append('other.panel', event);
    await events.append(status.domain, { ...event, id: 'other-node', nodeUuid: 'different-node' });
    const result = await events.list(status.domain, [uuid], t - 1, t + 1);
    expect(result.events).toEqual([event]);
    expect(result.truncated).toBe(false);
    expect((await events.list(status.domain, [uuid], t + 1, t + 2)).events).toEqual([]);
    await db.execute(sql`delete from app_meta where key like 'node.events.%'`);
  });

  it('не делает вывод по первому снимку или краткой просадке', async () => {
    await baseline();
    await snapshot(10);
    await snapshot(100);
    expect(await list()).toHaveLength(0);
    expect(tcp.checkNode).not.toHaveBeenCalled();
  });
  it('подтверждает падение тремя снимками, сохраняет diagnostics и deduplicates открытый инцидент', async () => {
    await baseline();
    await collapse();
    await snapshot(10);
    const incidents = await list();
    expect(incidents).toHaveLength(1);
    expect(incidents[0]).toMatchObject({
      nodeUuid: uuid,
      kind: 'node_blocked',
      serverName: node.name,
      diagnostics: {
        source: 'checkhost',
        online: { before: 100, after: 10 },
        report: { verdict: 'russia_unreachable' },
      },
    });
    expect(tcp.checkNode).toHaveBeenCalledWith(node.address, 5492, 8443);
    expect(tcp.checkNode).toHaveBeenCalledTimes(1);
    expect(notifications.push).toHaveBeenCalledTimes(1);
  });
  it('полный TCP-отказ создаёт server_down; неизвестный результат не выдаёт блокировку за доказанную', async () => {
    tcp.checkNode.mockImplementation(async () => report('port_unreachable'));
    await baseline();
    await collapse();
    expect((await list())[0]?.kind).toBe('server_down');
  });
  it('недостаток TCP-данных сохраняется как неизвестный результат', async () => {
    tcp.checkNode.mockImplementation(async () => report('unknown'));
    await baseline();
    await collapse();
    const row = (await list())[0];
    expect(row?.diagnostics?.report.verdict).toBe('unknown');
    expect(row?.detail).toContain('недостаточно данных');
    expect(row?.title).not.toContain('недоступность из РФ');
  });
  it('выключенный мониторинг не вызывает внешние проверки и не создаёт инциденты', async () => {
    await settings.set({ enabled: false });
    await baseline();
    await collapse();
    await job.runScheduledTcp();
    expect(await list()).toHaveLength(0);
    expect(tcp.checkNode).not.toHaveBeenCalled();
  });
  it('устаревший снимок и отключённая нода не становятся аварией', async () => {
    status.checkedAt = new Date(Date.now() - 10 * 60_000).toISOString();
    await job.run();
    await job.runScheduledTcp();
    node.isDisabled = true;
    await baseline();
    await collapse();
    await job.runScheduledTcp();
    expect(await list()).toHaveLength(0);
    expect(tcp.checkNode).not.toHaveBeenCalled();
  });
  it('плановая TCP-проверка записывает результат и не повторяется раньше интервала', async () => {
    await job.runScheduledTcp();
    await job.runScheduledTcp();
    expect(tcp.checkNode).toHaveBeenCalledTimes(1);
    expect(await list()).toHaveLength(1);
    const states = await db.execute(sql`select value from app_meta where key like 'monitor.tcp.%'`);
    expect(JSON.stringify(states.rows)).toContain('russia_unreachable');
  });
  it('смена адреса при незавершённой проверке отбрасывает результат старого адреса', async () => {
    tcp.checkNode.mockImplementation(async () => {
      const old = report('russia_unreachable');
      node.address = '198.51.100.10';
      return old;
    });
    await job.runScheduledTcp();
    expect(await list()).toHaveLength(0);
    expect(notifications.push).not.toHaveBeenCalled();
  });
  it('смена панели при незавершённой проверке отбрасывает результат старой панели', async () => {
    tcp.checkNode.mockImplementation(async () => {
      status.domain = 'other-panel.example.com';
      return report('russia_unreachable');
    });
    await job.runScheduledTcp();
    expect(await list()).toHaveLength(0);
  });
  it('TCP-восстановление закрывает плановый инцидент, сохраняет историю и отправляет одно восстановление', async () => {
    await job.runScheduledTcp();
    await db.execute(sql`delete from app_meta where key like 'monitor.tcp.%'`);
    tcp.checkNode.mockImplementation(async () => report('reachable'));
    await job.runScheduledTcp();
    expect(await list()).toHaveLength(0);
    expect((await list('resolved'))[0]).toMatchObject({ nodeUuid: uuid, resolvedBy: 'auto' });
    expect(notifications.push).toHaveBeenCalledTimes(2);
  });
  it('свои пороги нагрузки на ядро и памяти создают устойчивые события в настоящей БД', async () => {
    await settings.set({
      cpuEnabled: true,
      memoryEnabled: true,
      loadPerCore: 1.5,
      memoryPercent: 90,
      resourceDurationMinutes: 1,
    });
    await db.execute(
      sql`insert into app_meta(key,value) values(${`settings.node-view.panel.example.com:${uuid}`}, ${JSON.stringify({ loadWarningPerCore: 1, memoryWarningPercent: 75 })})`,
    );
    // 4,8 за 15 минут на 4 ядра — 1,2 на ядро: выше своего порога 1,0, ниже общего 1,5.
    node.loadAverage = [5, 5, 4.8];
    node.memoryUsedBytes = 80;
    await snapshot(100);
    expect(await list()).toHaveLength(0);
    stamp += 61000;
    await snapshot(100);
    expect((await list()).map((i) => i.kind).sort()).toEqual(['cpu_high', 'mem_high']);
  });
  it('без своих порогов нагрузка на ядро и память берут общий порог', async () => {
    await settings.set({
      cpuEnabled: true,
      memoryEnabled: true,
      loadPerCore: 1.5,
      memoryPercent: 90,
      resourceDurationMinutes: 1,
    });
    node.loadAverage = [5, 5, 4.8];
    node.memoryUsedBytes = 80;
    await snapshot(100);
    stamp += 61000;
    await snapshot(100);
    expect(await list()).toHaveLength(0);
  });
});
