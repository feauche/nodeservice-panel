import type { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import {
  CSRF_HEADER,
  nodeConnectionsSchema,
  type RemnawaveCert,
  type RemnawaveStatus,
  remnawaveStatusSchema,
} from '@nodeservice/shared';
import { sql } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import { generate } from 'otplib';
import request from 'supertest';
import TestAgent from 'supertest/lib/agent.js';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { AppModule } from '../src/app.module.js';
import { setupHttp } from '../src/common/http/setup-http.js';
import { DB, type Db } from '../src/infra/db/db.module.js';
import { runMigrations } from '../src/infra/db/migrate.js';
import { VALKEY } from '../src/infra/valkey/valkey.module.js';
import { SetupService } from '../src/modules/auth/setup.service.js';
import { NodeMetricsService } from '../src/modules/node-metrics/node-metrics.controller.js';
import { NodeStatsService } from '../src/modules/node-metrics/node-stats.service.js';
import { HOST_RESOLVER } from '../src/modules/remnawave/host-addresses.service.js';
import { NodePreferencesStore } from '../src/modules/remnawave/node-preferences.store.js';
import { RemnawaveService } from '../src/modules/remnawave/remnawave.service.js';
import {
  REMNAWAVE_CLIENT,
  RemnawaveApiError,
  type RemnawaveClient,
} from '../src/modules/remnawave/remnawave-client.js';
import { listenLocal } from './listen-local.js';

const LOGIN = 'admin';
const PASSWORD = 'correct horse battery staple';

if (!process.env.DATABASE_URL?.endsWith('/nodeservice_test'))
  throw new Error('e2e: DATABASE_URL должен указывать на nodeservice_test');

const CERT_OK: RemnawaveCert = {
  status: 'ok',
  expiresAt: '2027-01-01T00:00:00.000Z',
  daysLeft: 90,
  note: null,
};

/** Как GEO_LOOKUP в server-country.e2e-spec.ts: подменяем внешний клиент целиком, сеть не трогаем. */
class FakeRemnawaveClient implements RemnawaveClient {
  goodToken = 'rw_pat_good';
  usersOnline = 42;
  nodesOnline = 1;
  down = false;
  /** Подключения ноды не читаются (профиль недоступен), остальное работает. */
  connectionsFail = false;
  cert: RemnawaveCert = CERT_OK;
  domainsAsked: string[] = [];

  async fetch(domain: string, apiKey: string) {
    this.domainsAsked.push(domain);
    if (domain === 'unreachable.example.com' || this.down)
      throw new RemnawaveApiError('Remnawave не отвечает.', 'unreachable');
    if (apiKey !== this.goodToken)
      throw new RemnawaveApiError('Remnawave ответила «доступ запрещён».', 'unauthorized');
    return {
      stats: {
        users: { total: 870, active: 800, disabled: 40, limited: 10, expired: 20 },
        online: { now: this.usersOnline, lastDay: 500, lastWeek: 700, never: 10 },
        nodesOnline: this.nodesOnline,
        nodesTotal: 1,
        trafficBytesLifetime: '20000000000000',
        panelVersion: '2.1.10',
        panelUptimeSec: 12_345,
      },
      nodes: [
        {
          uuid: 'n1',
          name: 'bridge',
          address: '104.171.133.254',
          countryCode: 'PL',
          isConnected: true,
          isDisabled: false,
          isConnecting: false,
          lastStatusMessage: null,
          usersOnline: this.usersOnline,
          trafficUsedBytes: 1000,
          trafficLimitBytes: null,
        },
      ],
    };
  }

  async checkCertificate(): Promise<RemnawaveCert> {
    return this.cert;
  }

  async findNodeInbound() {
    return null;
  }

  async listNodeConnections() {
    if (this.connectionsFail) throw new RemnawaveApiError('Remnawave не отвечает.', 'unreachable');
    return {
      items: [
        {
          tag: 'VLESS_TCP_REALITY',
          protocol: 'vless',
          security: 'reality',
          network: 'raw',
          port: 443,
          names: ['www.example.com', 'example.com'],
        },
        { tag: 'SS_BRIDGE', protocol: 'shadowsocks', security: null, network: null, port: 9999, names: [] },
      ],
      primary: 'VLESS_TCP_REALITY',
    };
  }

  async listSnippets() {
    return [];
  }

  async listSquads() {
    return { internal: [], external: [] };
  }

  async userByUsername() {
    return null;
  }

  async userDevices() {
    return null;
  }
}

describe('Remnawave e2e (J4)', () => {
  let app: INestApplication;
  let agent: InstanceType<typeof TestAgent>;
  let csrf: string;
  const fake = new FakeRemnawaveClient();

  const status = async (): Promise<RemnawaveStatus> =>
    remnawaveStatusSchema.parse((await agent.get('/api/nodes/status').expect(200)).body);
  const auditActions = async () =>
    JSON.stringify((await agent.get('/api/audit?pageSize=50').expect(200)).body);

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(REMNAWAVE_CLIENT)
      .useValue(fake)
      // Вместо настоящего DNS: домен сервера указывает на адрес ноды.
      .overrideProvider(HOST_RESOLVER)
      .useValue({
        resolve: async (host: string) => (host === 'bridge.example.com' ? ['104.171.133.254'] : []),
      })
      .compile();
    app = moduleRef.createNestApplication<NestExpressApplication>({ bufferLogs: false, logger: false });
    setupHttp(app as NestExpressApplication);
    const db = app.get<Db>(DB);
    await runMigrations(db);
    await db.execute(sql`truncate users, recovery_codes, trusted_devices, setup_tokens cascade`);
    await db.execute(sql`delete from app_meta where key like 'settings.%'`);
    await app.get<Redis>(VALKEY).flushdb();
    await listenLocal(app);
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
  }, 120_000);

  afterAll(async () => {
    await app?.close();
  });

  it('не подключено изначально', async () => {
    expect(await status()).toEqual({
      connected: false,
      domain: null,
      checkedAt: null,
      lastAttemptAt: null,
      error: null,
      stats: null,
      nodes: [],
      cert: null,
    });
  });

  it('без входа недоступно', async () => {
    const anon = request(app.getHttpServer());
    await anon.get('/api/nodes/status').expect(401);
  });

  it('неверный токен: 400, ничего не подключается', async () => {
    const res = await agent
      .post('/api/nodes/connect')
      .set(CSRF_HEADER, csrf)
      .send({ domain: 'vpn-panel.example.com', apiKey: 'rw_pat_bad' })
      .expect(400);
    expect(JSON.stringify(res.body)).toContain('доступ запрещён');
    expect((await status()).connected).toBe(false);
  });

  it('домен не отвечает: 502', async () => {
    await agent
      .post('/api/nodes/connect')
      .set(CSRF_HEADER, csrf)
      .send({ domain: 'unreachable.example.com', apiKey: 'rw_pat_good' })
      .expect(502);
  });

  it('успешное подключение: домен нормализован (без протокола и хвостового слэша), сводка, нода, версия панели; запись в Журнале', async () => {
    const res = await agent
      .post('/api/nodes/connect')
      .set(CSRF_HEADER, csrf)
      .send({ domain: 'https://VPN-Panel.example.com/', apiKey: 'rw_pat_good' })
      .expect(200);
    const s = remnawaveStatusSchema.parse(res.body);
    expect(s.domain).toBe('VPN-Panel.example.com');
    expect(fake.domainsAsked.at(-1)).toBe('VPN-Panel.example.com');
    expect(s.connected).toBe(true);
    expect(s.stats).toMatchObject({ users: { total: 870 }, panelVersion: '2.1.10' });
    expect(s.nodes).toEqual([
      {
        uuid: 'n1',
        name: 'bridge',
        address: '104.171.133.254',
        countryCode: 'PL',
        isConnected: true,
        isDisabled: false,
        isConnecting: false,
        lastStatusMessage: null,
        usersOnline: 42,
        trafficUsedBytes: 1000,
        trafficLimitBytes: null,
        // Скорость — только по замеру счётчиков панелью; сразу после подключения замера ещё нет.
        rxBytesPerSec: null,
        txBytesPerSec: null,
      },
    ]);
    expect(s.cert).toEqual(CERT_OK);
    expect(await auditActions()).toContain('remnawave.connected');
  });

  it('обновить: свежие цифры без повторной отправки токена', async () => {
    fake.usersOnline = 55;
    const res = await agent.post('/api/nodes/refresh').set(CSRF_HEADER, csrf).expect(200);
    expect(remnawaveStatusSchema.parse(res.body).stats?.online.now).toBe(55);
    fake.usersOnline = 42;
  });

  it('подключения ноды: порты и имена SNI, основное — Reality; сбой чтения не выдаётся за «подключений нет»', async () => {
    const uuid = 'c0000000-0000-4000-8000-000000000001';
    const ok = nodeConnectionsSchema.parse(
      (await agent.get(`/api/nodes/${uuid}/connections`).expect(200)).body,
    );
    expect(ok.failed).toBe(false);
    expect(ok.primary).toBe('VLESS_TCP_REALITY');
    expect(ok.items.map((i) => [i.tag, i.port])).toEqual([
      ['VLESS_TCP_REALITY', 443],
      ['SS_BRIDGE', 9999],
    ]);
    expect(ok.items[0]?.names).toEqual(['www.example.com', 'example.com']);
    fake.connectionsFail = true;
    const bad = nodeConnectionsSchema.parse(
      (await agent.get(`/api/nodes/${uuid}/connections`).expect(200)).body,
    );
    fake.connectionsFail = false;
    expect(bad).toEqual({ items: [], primary: null, failed: true });
    // Не uuid — 400, без входа — 401.
    await agent.get('/api/nodes/not-a-uuid/connections').expect(400);
    await request(app.getHttpServer()).get(`/api/nodes/${uuid}/connections`).expect(401);
  });

  it('отметка «Сервер белого списка» из настроек ноды видна в списке нод', async () => {
    const prefs = app.get(NodePreferencesStore);
    expect((await status()).nodes[0]?.whitelist).toBeUndefined();
    const saved = await prefs.set('n1', { ...(await prefs.get('n1')), whitelist: true });
    expect(saved.whitelist).toBe(true);
    expect((await status()).nodes[0]?.whitelist).toBe(true);
    await prefs.set('n1', { ...saved, whitelist: false });
    expect((await status()).nodes[0]?.whitelist).toBeUndefined();
  });

  it('плановая перепроверка (джоба): недоступность и восстановление отражаются в статусе и Журнале', async () => {
    const svc = app.get(RemnawaveService);
    fake.down = true;
    await svc.syncQuiet();
    let s = await status();
    expect(s.connected).toBe(true);
    expect(s.error).toBeTruthy();
    expect(s.stats?.users.total).toBe(870); // прежние данные не потерялись
    expect(await auditActions()).toContain('remnawave.unreachable');
    fake.down = false;
    await svc.syncQuiet();
    s = await status();
    expect(s.error).toBeNull();
    expect(await auditActions()).toContain('remnawave.reconnected');
  });

  it('замеры: отчёт за период, сумма парка и запас считаются запросами к настоящей базе', async () => {
    const db = app.get<Db>(DB);
    const domain = (await status()).domain ?? '';
    const node = '0192f200-0000-7000-8000-0000000000aa';
    const now = Date.now();
    // Три дня снимков раз в 15 минут: онлайн волной 100–500, нагрузка и память растут вместе с ним.
    const rows = Array.from({ length: 3 * 96 }, (_, i) => {
      const online = Math.round(300 + 200 * Math.sin((i / 96) * 2 * Math.PI));
      const values = {
        cpu: null,
        ram: 20 + online * 0.04,
        load: 0.4 + online * 0.004,
        rx: online * 1000,
        tx: online * 900,
        online,
        up: 1,
      };
      const at = new Date(now - (3 * 96 - i) * 15 * 60_000 + 1234).toISOString();
      return sql`(${domain}, ${node}::uuid, ${at}::timestamptz, ${JSON.stringify(values)}::jsonb)`;
    });
    await db.execute(
      sql`INSERT INTO remna_metric_samples(panel,node_uuid,sampled_at,values) VALUES ${sql.join(rows, sql`, `)}`,
    );
    try {
      const statsService = app.get(NodeStatsService);
      // Трафик берётся у Remnawave по сети — здесь его нет.
      vi.spyOn(statsService as never, 'traffic').mockResolvedValue({ traffic: null, error: null } as never);
      const stats = await statsService.get(7);
      expect(stats.online.peak).toBe(500);
      expect(stats.online.minimum).toBe(100);
      expect(stats.heatmap.days).toBeGreaterThanOrEqual(3);
      expect(stats.heatmap.peak).not.toBeNull();
      expect(stats.online.series.filter((p) => p.v != null).length).toBeGreaterThan(60);
      expect(stats.timeZone).toBeTruthy();

      const metrics = app.get(NodeMetricsService);
      vi.spyOn(metrics, 'collect').mockResolvedValue();
      const day = await metrics.get(1440);
      const fleet = day.fleet.filter((p) => p.nodes > 0);
      expect(fleet.length).toBeGreaterThan(10);
      expect(fleet.every((p) => p.up === 1)).toBe(true);
      // Пятнадцатиминутные снимки в корзинах по 6 минут: пропуск между ними — перерыв, а не одиночная дыра.
      expect(day.bucketSeconds).toBe(360);

      // Обычный онлайн в этот час — по трём прошлым дням в тот же час.
      const hour = await metrics.get(60);
      expect(hour.onlineTypical).not.toBeNull();
      expect(hour.onlineTypical?.low).toBeLessThanOrEqual(hour.onlineTypical?.high ?? 0);
      // И у самой ноды: волна 100–500 в одном и том же часе трёх дней.
      expect(hour.onlineTypicalByNode[node]).toBeDefined();

      const points = await metrics.capacityPoints(domain);
      expect(points.get(node)?.length).toBeGreaterThan(200);
    } finally {
      vi.restoreAllMocks();
      await db.execute(sql`DELETE FROM remna_metric_samples WHERE node_uuid = ${node}::uuid`);
    }
  });

  it('отключение стирает всё, запись в Журнале', async () => {
    await agent.delete('/api/nodes/connection').set(CSRF_HEADER, csrf).expect(204);
    expect(await status()).toMatchObject({ connected: false });
    expect(await auditActions()).toContain('remnawave.disconnected');
  });

  it('неверный формат запроса на подключение отклоняется 400', async () => {
    for (const bad of [{ domain: 'x' }, { apiKey: 'k' }, { domain: '', apiKey: '' }])
      expect([400, 422]).toContain(
        (await agent.post('/api/nodes/connect').set(CSRF_HEADER, csrf).send(bad)).status,
      );
  });
});
