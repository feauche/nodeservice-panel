import type { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import {
  CSRF_HEADER,
  fleetStatsSchema,
  overviewMetricsResponseSchema,
  serverMetricsResponseSchema,
  serverSchema,
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

if (!process.env.DATABASE_URL?.endsWith('/nodeservice_test'))
  throw new Error('e2e: DATABASE_URL должен указывать на nodeservice_test');

const VM = process.env.VM_URL ?? 'http://127.0.0.1:8428';

/**
 * Известный ряд, как его пишет шлюз агента: скорость сети в БАЙТАХ в секунду. Десять минут ровно 12,5 МБ/с
 * на приём (это 100 Мбит/с) и 2,5 МБ/с на отдачу (20 Мбит/с), точка раз в 10 секунд; точки старше
 * latencyOffset хранилища.
 */
const netSeries = (serverId: string): string => {
  const now = Date.now();
  // Сервер переименовали посреди окна: первая половина точек — под старым именем, вторая — под новым. Объём и
  // скорость от этого меняться не должны.
  const label = (back: number) =>
    `{server_id="${serverId}",server_name="${back > 360 ? 'metrics-host-old' : 'metrics-host'}"}`;
  const lines: string[] = [];
  for (let back = 660; back >= 60; back -= 10) {
    lines.push(`nodeservice_net_rx_bps${label(back)} 12500000 ${now - back * 1000}`);
    lines.push(`nodeservice_net_tx_bps${label(back)} 2500000 ${now - back * 1000}`);
  }
  return `${lines.join('\n')}\n`;
};

describe('metrics e2e', () => {
  let app: INestApplication;
  let agent: InstanceType<typeof TestAgent>;
  let csrf: string;
  let serverId = '';
  let vmUp = false;

  beforeAll(async () => {
    try {
      vmUp = (await fetch(`${VM}/health`, { signal: AbortSignal.timeout(2_000) })).ok;
    } catch {
      vmUp = false;
    }
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication<NestExpressApplication>({ bufferLogs: false, logger: false });
    setupHttp(app as NestExpressApplication);
    const db = app.get<Db>(DB);
    await runMigrations(db);
    await db.execute(sql`truncate users, recovery_codes, trusted_devices, setup_tokens, servers cascade`);
    await db.execute(sql`delete from app_meta where key like 'settings.%' or key = 'panel.ssh-key'`);
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
    // сервер без проверки: метрикам SSH не нужен
    const created = await agent
      .post('/api/servers')
      .set(CSRF_HEADER, csrf)
      .send({
        name: 'metrics-host',
        host: '203.0.113.99',
        port: 22,
        sshUser: 'root',
        auth: { method: 'panel-key' },
        verify: false,
      })
      .expect(201);
    serverId = serverSchema.parse(created.body).id;
    // Ряд для статистики парка пишем заранее: новый ряд VM показывает не сразу, а через несколько секунд.
    if (vmUp) await fetch(`${VM}/api/v1/import/prometheus`, { method: 'POST', body: netSeries(serverId) });
  }, 60_000);

  afterAll(async () => {
    await app?.close();
  });

  it('серии сервера: точки из VictoriaMetrics приходят в контракте', async (ctx) => {
    if (!vmUp) return ctx.skip();
    // пишем три точки CPU напрямую в VM (как это делает шлюз агента)
    const now = Date.now();
    // точки старше search.latencyOffset VictoriaMetrics (~30 с), иначе range их ещё «не видит»
    const lines = [60, 90, 120]
      .map(
        (back) =>
          `nodeservice_cpu_pct{server_id="${serverId}",server_name="metrics-host"} 42.5 ${now - back * 1000}`,
      )
      .join('\n');
    await fetch(`${VM}/api/v1/import/prometheus`, { method: 'POST', body: `${lines}\n` });

    // VM может отдать данные не мгновенно — короткий повтор
    const deadline = Date.now() + 15_000;
    let cpuPoints = 0;
    for (;;) {
      const res = await agent.get(`/api/metrics/servers/${serverId}?range=1h`).expect(200);
      const parsed = serverMetricsResponseSchema.parse(res.body);
      expect(parsed.vmOk).toBe(true);
      cpuPoints = parsed.series.cpuPct.filter((p) => p.v !== null).length;
      if (cpuPoints > 0 || Date.now() > deadline) {
        expect(parsed.series.cpuPct.some((p) => p.v === 42.5)).toBe(true);
        break;
      }
      await new Promise((r) => setTimeout(r, 400));
    }
    expect(cpuPoints).toBeGreaterThan(0);
  }, 20_000);

  it('сводка обзора: последние значения по серверу — только пока агент на связи', async (ctx) => {
    if (!vmUp) return ctx.skip();
    const mine = async () => {
      const res = await agent.get('/api/metrics/overview').expect(200);
      const parsed = overviewMetricsResponseSchema.parse(res.body);
      expect(parsed.vmOk).toBe(true);
      const row = parsed.servers.find((s) => s.serverId === serverId);
      expect(row).toBeDefined();
      return row;
    };
    // Агент не на связи: прошлые значения устарели, панель их не показывает (решение владельца 29.09.2026).
    expect((await mine())?.cpuPct).toBeNull();
    await app.get<Db>(DB).execute(sql`update servers set agent_status = 'online' where id = ${serverId}`);
    expect((await mine())?.cpuPct).toBe(42.5);
  });

  it('диапазон валидируется, чужой формат — 400', async () => {
    await agent.get(`/api/metrics/servers/${serverId}?range=5m`).expect(400);
  });

  it('статистика парка: скорость сети агент пишет в байтах в секунду — объём в байтах, скорость в бит/с', async (ctx) => {
    if (!vmUp) return ctx.skip();
    // Ряд записан в beforeAll (netSeries). VM отдаёт его не мгновенно — ждём, пока появятся и объём, и
    // точки скорости.
    const read = async () =>
      fleetStatsSchema.parse((await agent.get('/api/fleet/stats?period=day').expect(200)).body);
    const deadline = Date.now() + 15_000;
    let st = await read();
    // Рядов два (сервер переименовали посреди окна): ждём, пока хранилище покажет оба, — иначе объём был бы
    // только за половину окна.
    const visible = () =>
      (st.traffic.rxBytes ?? 0) > 7.5e9 * 0.9 &&
      (st.traffic.txBytes ?? 0) > 1.5e9 * 0.9 &&
      st.traffic.speed.length > 0;
    while (!visible() && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 400));
      st = await read();
    }
    expect(st.vmOk).toBe(true);
    const near = (v: number | null | undefined, want: number) => {
      expect(v ?? 0).toBeGreaterThan(want * 0.9);
      expect(v ?? 0).toBeLessThan(want * 1.1);
    };
    // За 600 секунд при 12,5 МБ/с принято 7,5 ГБ, при 2,5 МБ/с отдано 1,5 ГБ — байты, без деления на 8.
    near(st.traffic.rxBytes, 7.5e9);
    near(st.traffic.txBytes, 1.5e9);
    near(
      st.traffic.buckets.reduce((a, b) => a + b.bytes, 0),
      9e9,
    );
    near(st.servers.find((x) => x.id === serverId)?.trafficBytes, 9e9);
    // Скорость — в бит/с: 15 МБ/с в сумме — это 120 Мбит/с; по направлениям 100 и 20.
    expect(st.traffic.peakBps).toBe(120e6);
    expect(st.traffic.avgBps).toBe(120e6);
    expect(st.traffic.speed.length).toBeGreaterThan(0);
    for (const p of st.traffic.speed) expect(p).toMatchObject({ rx: 100e6, tx: 20e6 });
  }, 20_000);
});
