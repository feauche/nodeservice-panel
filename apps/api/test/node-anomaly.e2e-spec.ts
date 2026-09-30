import type { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import {
  CSRF_HEADER,
  incidentsListResponseSchema,
  type RemnawaveCert,
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
import { tcpOpen } from '../src/common/net/tcp-open.js';
import { DB, type Db } from '../src/infra/db/db.module.js';
import { runMigrations } from '../src/infra/db/migrate.js';
import { VALKEY } from '../src/infra/valkey/valkey.module.js';
import { SetupService } from '../src/modules/auth/setup.service.js';
import { IncidentsService } from '../src/modules/incidents/incidents.service.js';
import { NodeAnomalyJob } from '../src/modules/incidents/node-anomaly.job.js';
import { NodeBlockRecheckJob } from '../src/modules/incidents/node-block-recheck.job.js';
import { RemnawaveService } from '../src/modules/remnawave/remnawave.service.js';
import {
  REMNAWAVE_CLIENT,
  type RemnawaveClient,
  type RemnawaveNodeInbound,
} from '../src/modules/remnawave/remnawave-client.js';
import { FakeSsh, SSH_PASSWORD, SSH_USER } from './fake-ssh.js';

if (!process.env.DATABASE_URL?.endsWith('/nodeservice_test'))
  throw new Error('e2e: DATABASE_URL должен указывать на nodeservice_test');

const LOGIN = 'admin';
const PASSWORD = 'correct horse battery staple';

const CERT_OK: RemnawaveCert = {
  status: 'ok',
  expiresAt: '2027-01-01T00:00:00.000Z',
  daysLeft: 90,
  note: null,
};

/**
 * Та же единственная нода Remnawave, что и в жизни: онлайн и время снимка меняются между вызовами
 * fetch(). Адрес ноды НАРОЧНО не совпадает ни с одним сервером панели («ru-probe» — 127.0.0.1) —
 * доказывает, что саму упавшую ноду не нужно добавлять в NodeService, чтобы её проверить.
 */
class FakeRemnawaveClient implements RemnawaveClient {
  node = { uuid: 'node-1', name: 'проверяемая-нода', address: '198.51.100.9', online: 100 };
  inbound: RemnawaveNodeInbound | null = { sni: 'www.example.com', port: 8443 };

  async fetch() {
    return {
      stats: {
        users: { total: 100, active: 100, disabled: 0, limited: 0, expired: 0 },
        online: { now: this.node.online, lastDay: 100, lastWeek: 100, never: 0 },
        nodesOnline: 1,
        nodesTotal: 1,
        trafficBytesLifetime: '0',
        panelVersion: '2.1.10',
        panelUptimeSec: 1,
      },
      nodes: [
        {
          uuid: this.node.uuid,
          name: this.node.name,
          address: this.node.address,
          countryCode: 'DE',
          isConnected: true,
          isDisabled: false,
          isConnecting: false,
          lastStatusMessage: null,
          usersOnline: this.node.online,
          trafficUsedBytes: 0,
          trafficLimitBytes: null,
        },
      ],
    };
  }

  async checkCertificate(): Promise<RemnawaveCert> {
    return CERT_OK;
  }

  async findNodeInbound(): Promise<RemnawaveNodeInbound | null> {
    return this.inbound;
  }
}

/**
 * J10 целиком: тик аномалии сравнивает два снимка Remnawave, находит резкое падение онлайна, просит
 * NodeBlockCheckService проверить блокировку с российского сервера парка по SSH (тот же способ, что
 * и встречные проверки доступности) и заводит инцидент только по результату этой проверки.
 */
describe('J10: аномалия онлайна → проверка блокировки → инцидент (e2e)', () => {
  let app: INestApplication;
  let agent: InstanceType<typeof TestAgent>;
  let csrf: string;
  const ssh = new FakeSsh();
  const fake = new FakeRemnawaveClient();

  beforeAll(async () => {
    await ssh.start();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(REMNAWAVE_CLIENT)
      .useValue(fake)
      .compile();
    app = moduleRef.createNestApplication<NestExpressApplication>({ bufferLogs: false, logger: false });
    setupHttp(app as NestExpressApplication);
    const db = app.get<Db>(DB);
    await runMigrations(db);
    await db.execute(
      sql`truncate users, recovery_codes, trusted_devices, setup_tokens, servers, incidents, billing_items cascade`,
    );
    await db.execute(sql`delete from app_meta where key like 'settings.%' or key = 'panel.ssh-key'`);
    await app.get<Redis>(VALKEY).flushdb();
    await app.init();
    // Порт SSH с панели проверяется настоящим подключением. На машине с прозрачным прокси (VPN-клиент в режиме
    // TUN) подключение к любому адресу «проходит», и сервер с тестовым адресом из документации считался бы
    // работающим. По задумке тестов такие серверы недоступны — отвечает только 127.0.0.1 (тестовый SSH).
    app.get(IncidentsService).probeHost = async (host, port) => host === '127.0.0.1' && tcpOpen(host, port);
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
        name: 'ru-probe',
        host: '127.0.0.1',
        port: ssh.port,
        sshUser: SSH_USER,
        auth: { method: 'password', password: SSH_PASSWORD },
        country: { mode: 'manual', code: 'RU' },
      })
      .expect(201);
    serverSchema.parse(created.body);

    await agent
      .post('/api/remnawave/connect')
      .set(CSRF_HEADER, csrf)
      .send({ domain: 'vpn-panel.example.com', apiKey: 'whatever' })
      .expect(200);
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await ssh.stop();
  });

  it('первый тик — только базовый снимок, инцидента ещё нет', async () => {
    await app.get(NodeAnomalyJob).run();
    const list = incidentsListResponseSchema.parse(
      (await agent.get('/api/incidents?status=open').expect(200)).body,
    );
    expect(list.items.some((i) => i.kind === 'node_blocked')).toBe(false);
  });

  it('короткая просадка (перезагрузка сервера): онлайн упал и на следующем же снимке вернулся → инцидент не заводится', async () => {
    fake.node.online = 5;
    await app.get(RemnawaveService).refresh();
    await app.get(NodeAnomalyJob).run(); // кандидат: просадка увидена, но не подтверждена

    fake.node.online = 100;
    await app.get(RemnawaveService).refresh();
    await app.get(NodeAnomalyJob).run(); // подтверждение: онлайн уже в норме — инцидент не открылся

    const list = incidentsListResponseSchema.parse(
      (await agent.get('/api/incidents?status=open').expect(200)).body,
    );
    expect(list.items.some((i) => i.kind === 'node_blocked')).toBe(false);
  });

  it('просадка держится две проверки, а на третьей онлайн вернулся → инцидент не заводится', async () => {
    fake.node.online = 5;
    await app.get(RemnawaveService).refresh();
    await app.get(NodeAnomalyJob).run();
    await app.get(RemnawaveService).refresh();
    await app.get(NodeAnomalyJob).run();
    fake.node.online = 100;
    await app.get(RemnawaveService).refresh();
    await app.get(NodeAnomalyJob).run();
    const list = incidentsListResponseSchema.parse(
      (await agent.get('/api/incidents?status=open').expect(200)).body,
    );
    expect(list.items.some((i) => i.kind === 'node_blocked')).toBe(false);
  });

  it('падение онлайна на 90% + тихий обрыв на этапе TLS с российского сервера парка → крит, «похоже на ТСПУ»', async () => {
    fake.node.online = 10;
    ssh.blockCheckOutput = '{"stage":"tls","ok":false,"stalledAtKb":null}';
    await app.get(RemnawaveService).refresh();
    await app.get(NodeAnomalyJob).run(); // кандидат: просадка увидена, ждём подтверждения
    await app.get(RemnawaveService).refresh();
    await app.get(NodeAnomalyJob).run(); // вторая проверка подряд — просадка держится
    await app.get(RemnawaveService).refresh(); // следующий снимок — online тот же (10), просадка держится
    await app.get(NodeAnomalyJob).run(); // подтверждение — только теперь открывается инцидент

    const list = incidentsListResponseSchema.parse(
      (await agent.get('/api/incidents?status=open').expect(200)).body,
    );
    const inc = list.items.find((i) => i.kind === 'node_blocked');
    expect(inc).toBeTruthy();
    expect(inc?.severity).toBe('crit');
    expect(inc?.title).toContain('ТСПУ');
    expect(inc?.title).toContain('проверяемая-нода');
    // Адрес ноды (198.51.100.9) ни с одним сервером панели не совпал — саму ноду добавлять не нужно.
    expect(inc?.serverName).toBe('проверяемая-нода');
    expect(inc?.detail).toContain('ru-probe');
    expect(inc?.detail).toContain('Онлайн: 100 → 10 (−90 %)');
    expect(inc?.detail).toContain('90');
    expect(inc?.timeline[0]?.result).toBe('detect');
  });

  it('падение онлайна, но проверка с российского сервера прошла чисто → предупреждение, без слова «блокировка» в заголовке', async () => {
    // Новая нода (свежий uuid) — у прошлой сейчас действует пауза в 30 минут на повтор проверки.
    fake.node = { uuid: 'node-2', name: 'вторая-нода', address: '198.51.100.10', online: 100 };
    ssh.blockCheckOutput = '{"stage":"data","ok":true,"stalledAtKb":null}';
    await app.get(RemnawaveService).refresh();
    await app.get(NodeAnomalyJob).run(); // базовый снимок для новой ноды, тревоги ещё нет

    fake.node.online = 10;
    await app.get(RemnawaveService).refresh();
    await app.get(NodeAnomalyJob).run(); // кандидат
    await app.get(RemnawaveService).refresh();
    await app.get(NodeAnomalyJob).run(); // вторая проверка подряд — просадка держится
    await app.get(RemnawaveService).refresh(); // просадка держится — подтверждение
    await app.get(NodeAnomalyJob).run();

    const list = incidentsListResponseSchema.parse(
      (await agent.get('/api/incidents?status=open').expect(200)).body,
    );
    const inc = list.items.find((i) => i.serverName === 'вторая-нода');
    expect(inc).toBeTruthy();
    expect(inc?.severity).toBe('warn');
    expect(inc?.title).not.toContain('Похоже');
    expect(inc?.title).toContain('не подтвердилась');
    expect(inc?.detail).toContain('ru-probe');
    expect(inc?.detail).toContain('Онлайн: 100 → 10 (−90 %)');
  });

  it('падение онлайна, но проверить нечем (нет ни порта, ни имени маскировки) → предупреждение «проверить не удалось», не крит', async () => {
    fake.node = { uuid: 'node-3', name: 'третья-нода', address: '198.51.100.11', online: 100 };
    fake.inbound = { sni: null, port: null };
    await app.get(RemnawaveService).refresh();
    await app.get(NodeAnomalyJob).run(); // базовый снимок

    fake.node.online = 10;
    await app.get(RemnawaveService).refresh();
    await app.get(NodeAnomalyJob).run(); // кандидат
    await app.get(RemnawaveService).refresh();
    await app.get(NodeAnomalyJob).run(); // вторая проверка подряд — просадка держится
    await app.get(RemnawaveService).refresh(); // просадка держится — подтверждение
    await app.get(NodeAnomalyJob).run();

    const list = incidentsListResponseSchema.parse(
      (await agent.get('/api/incidents?status=open').expect(200)).body,
    );
    const inc = list.items.find((i) => i.serverName === 'третья-нода');
    expect(inc).toBeTruthy();
    expect(inc?.severity).toBe('warn');
    expect(inc?.title).not.toContain('блокировк');
    expect(inc?.title).toContain('проверить не удалось');
    expect(inc?.detail).toContain('не нашёлся порт подключения');
  });

  it('инцидент открылся, а потом онлайн и проверка снова в порядке → перепроверка закрывает его сама', async () => {
    fake.node = { uuid: 'node-4', name: 'четвёртая-нода', address: '198.51.100.12', online: 100 };
    fake.inbound = { sni: 'www.example.com', port: 8443 };
    ssh.blockCheckOutput = '{"stage":"tls","ok":false,"stalledAtKb":null}';
    await app.get(RemnawaveService).refresh();
    await app.get(NodeAnomalyJob).run(); // базовый снимок

    fake.node.online = 10;
    await app.get(RemnawaveService).refresh();
    await app.get(NodeAnomalyJob).run(); // кандидат
    await app.get(RemnawaveService).refresh();
    await app.get(NodeAnomalyJob).run(); // вторая проверка подряд — просадка держится
    await app.get(RemnawaveService).refresh(); // просадка держится — подтверждение, инцидент открылся
    await app.get(NodeAnomalyJob).run();

    const opened = incidentsListResponseSchema.parse(
      (await agent.get('/api/incidents?status=open').expect(200)).body,
    );
    const inc = opened.items.find((i) => i.serverName === 'четвёртая-нода');
    expect(inc).toBeTruthy();
    expect(inc?.severity).toBe('crit');

    // Онлайн вернулся в норму, и повторная проверка блокировки теперь тоже чистая.
    fake.node.online = 100;
    ssh.blockCheckOutput = '{"stage":"data","ok":true,"stalledAtKb":null}';
    // Три снимка подряд с нормальным онлайном — только тогда закрываем.
    for (let i = 0; i < 2; i += 1) {
      await app.get(RemnawaveService).refresh();
      await app.get(NodeBlockRecheckJob).run();
    }
    const watching = incidentsListResponseSchema.parse(
      (await agent.get('/api/incidents?status=open').expect(200)).body,
    );
    const still = watching.items.find((i) => i.serverName === 'четвёртая-нода');
    expect(still).toBeTruthy();
    expect(still?.timeline.some((e) => e.action.startsWith('Онлайн вернулся: 100 (до падения 100)'))).toBe(
      true,
    );
    await app.get(RemnawaveService).refresh();
    await app.get(NodeBlockRecheckJob).run();

    const after = incidentsListResponseSchema.parse(
      (await agent.get('/api/incidents?status=open').expect(200)).body,
    );
    expect(after.items.some((i) => i.serverName === 'четвёртая-нода')).toBe(false);
    const resolved = incidentsListResponseSchema.parse(
      (await agent.get('/api/incidents?status=resolved').expect(200)).body,
    );
    const closed = resolved.items.find((i) => i.serverName === 'четвёртая-нода');
    expect(closed?.resolvedBy).toBe('auto');
    expect(closed?.timeline.at(-1)?.action).toContain('короткая просадка');
  });

  it('инцидент открылся, а проверка снова находит проблему → перепроверка его не закрывает', async () => {
    fake.node = { uuid: 'node-5', name: 'пятая-нода', address: '198.51.100.13', online: 100 };
    fake.inbound = { sni: 'www.example.com', port: 8443 };
    ssh.blockCheckOutput = '{"stage":"tls","ok":false,"stalledAtKb":null}';
    await app.get(RemnawaveService).refresh();
    await app.get(NodeAnomalyJob).run(); // базовый снимок

    fake.node.online = 10;
    await app.get(RemnawaveService).refresh();
    await app.get(NodeAnomalyJob).run(); // кандидат
    await app.get(RemnawaveService).refresh();
    await app.get(NodeAnomalyJob).run(); // вторая проверка подряд — просадка держится
    await app.get(RemnawaveService).refresh();
    await app.get(NodeAnomalyJob).run(); // подтверждение — инцидент открылся, крит

    // Онлайн вернулся, но встречная проверка всё ещё видит проблему — закрывать не должны.
    fake.node.online = 100;
    for (let i = 0; i < 3; i += 1) {
      await app.get(RemnawaveService).refresh();
      await app.get(NodeBlockRecheckJob).run();
    }

    const after = incidentsListResponseSchema.parse(
      (await agent.get('/api/incidents?status=open').expect(200)).body,
    );
    const kept = after.items.find((i) => i.serverName === 'пятая-нода');
    expect(kept).toBeTruthy();
    expect(kept?.timeline.at(-1)?.action).toContain('Оставляю открытым');
  });

  it('из России порт молчит, а с зарубежного сервера парка отвечает → крит «Похоже на блокировку IP из России»', async () => {
    // Второй сервер парка — «зарубежный»: тот же тестовый sshd, страна вручную DE.
    await agent
      .post('/api/servers')
      .set(CSRF_HEADER, csrf)
      .send({
        name: 'de-probe',
        host: 'localhost',
        port: ssh.port,
        sshUser: SSH_USER,
        auth: { method: 'password', password: SSH_PASSWORD },
        country: { mode: 'manual', code: 'DE' },
      })
      .expect(201);
    fake.node = { uuid: 'node-6', name: 'шестая-нода', address: '198.51.100.14', online: 100 };
    fake.inbound = { sni: 'www.example.com', port: 8443 };
    ssh.blockCheckOutput = '{"stage":"tcp","ok":false,"stalledAtKb":null}';
    ssh.blockCheckPortOnlyOutput = '{"stage":"port","ok":true,"stalledAtKb":null}';
    await app.get(RemnawaveService).refresh();
    await app.get(NodeAnomalyJob).run();
    fake.node.online = 5;
    await app.get(RemnawaveService).refresh();
    await app.get(NodeAnomalyJob).run();
    await app.get(RemnawaveService).refresh();
    await app.get(NodeAnomalyJob).run(); // вторая проверка подряд — просадка держится
    await app.get(RemnawaveService).refresh();
    await app.get(NodeAnomalyJob).run();

    const list = incidentsListResponseSchema.parse(
      (await agent.get('/api/incidents?status=open').expect(200)).body,
    );
    const inc = list.items.find((i) => i.serverName === 'шестая-нода');
    expect(inc?.severity).toBe('crit');
    expect(inc?.title).toContain('блокировку IP из России');
    expect(inc?.detail).toContain('Из-за рубежа:\n• de-probe — порт отвечает');
    expect(inc?.detail).toContain('Похоже: блокировка IP на стороне России');
    ssh.blockCheckPortOnlyOutput = null;
  });

  it('вход сервера-выхода: сохраняется только у чистого выхода, при падении онлайна проверяется и он', async () => {
    const db = app.get<Db>(DB);
    const ins = await db.execute<{ id: string }>(
      sql`insert into servers (name, host, ssh_user) values ('exit-srv', '198.51.100.30', 'root') returning id`,
    );
    const id = ins.rows[0]?.id ?? '';
    const patch = (profile: unknown, code = 200) =>
      agent.patch(`/api/servers/${id}`).set(CSRF_HEADER, csrf).send({ profile }).expect(code);
    await patch({ roles: ['exit'], upstream: { kind: 'rent', address: 'нет адреса' } }, 400);
    const saved = serverSchema.parse(
      (
        await patch({
          roles: ['exit'],
          upstream: { kind: 'rent', address: 'Entry.Example.com:9443', owner: ' Иван ' },
        })
      ).body,
    );
    expect(saved.profile.upstream).toEqual({
      kind: 'rent',
      serverId: null,
      address: 'entry.example.com:9443',
      owner: 'Иван',
    });

    fake.node = { uuid: 'node-7', name: 'седьмая-нода', address: '198.51.100.30', online: 100 };
    fake.inbound = { sni: 'www.example.com', port: 8443 };
    ssh.blockCheckOutput = '{"stage":"tcp","ok":false,"stalledAtKb":null}';
    await app.get(RemnawaveService).refresh();
    await app.get(NodeAnomalyJob).run();
    fake.node.online = 5;
    for (let i = 0; i < 3; i += 1) {
      await app.get(RemnawaveService).refresh();
      await app.get(NodeAnomalyJob).run();
    }
    const list = incidentsListResponseSchema.parse(
      (await agent.get('/api/incidents?status=open').expect(200)).body,
    );
    const inc = list.items.find((i) => i.serverName === 'exit-srv');
    expect(inc?.detail).toContain('Вход арендодателя (entry.example.com:9443), из России:');
    expect(inc?.detail).toContain(
      'Не отвечают ни выход, ни вход. Вход, скорее всего, пересылает трафик на этот сервер',
    );
    expect(inc?.detail).toContain('пишите арендодателю (Иван)');

    // И принимает, и выпускает — вход у сервера он сам: сохранённый вход убирается.
    const both = serverSchema.parse((await patch({ roles: ['entry', 'exit'] })).body);
    expect(both.profile.upstream).toBeNull();
  });

  it('окно оплаты: выход работает, вход арендодателя молчит, срок оплаты через пару часов → «проверьте оплату»', async () => {
    const db = app.get<Db>(DB);
    const ins = await db.execute<{ id: string }>(
      sql`insert into servers (name, host, ssh_user) values ('guardora', '198.51.100.40', 'root') returning id`,
    );
    const id = ins.rows[0]?.id ?? '';
    await agent
      .patch(`/api/servers/${id}`)
      .set(CSRF_HEADER, csrf)
      .send({
        profile: {
          roles: ['exit'],
          upstream: { kind: 'rent', address: 'entry.example.com:9443', owner: 'Guardora' },
        },
      })
      .expect(200);
    // Срок в «Биллинге» ещё не прошёл, но до него меньше суток — окно оплаты.
    await db.execute(
      sql`insert into billing_items (kind, title, server_ids, amount_minor, currency, period_unit, period_count, paid_until)
          values ('rent', 'Guardora', ${JSON.stringify([id])}::jsonb, 250000, 'RUB', 'month', 1, now() + interval '3 hours')`,
    );

    fake.node = { uuid: 'node-8', name: 'guardora (Аренда)', address: '198.51.100.40', online: 211 };
    fake.inbound = { sni: 'www.example.com', port: 8443 };
    // Выход проходит полную проверку, а порт входа (проверка только порта) не отвечает.
    ssh.blockCheckOutput = '{"stage":"data","ok":true,"stalledAtKb":null}';
    ssh.blockCheckPortOnlyOutput = '{"stage":"tcp","ok":false,"stalledAtKb":null}';
    await app.get(RemnawaveService).refresh();
    await app.get(NodeAnomalyJob).run();
    fake.node.online = 0;
    for (let i = 0; i < 3; i += 1) {
      await app.get(RemnawaveService).refresh();
      await app.get(NodeAnomalyJob).run();
    }
    ssh.blockCheckPortOnlyOutput = null;

    const list = incidentsListResponseSchema.parse(
      (await agent.get('/api/incidents?status=open').expect(200)).body,
    );
    const inc = list.items.find((i) => i.serverName === 'guardora');
    expect(inc?.title).toBe('Резко упал онлайн — проверьте оплату · guardora (Аренда)');
    // Блокировка не подтверждена — это по-прежнему предупреждение, а не крит.
    expect(inc?.kind).toBe('node_blocked');
    expect(inc?.severity).toBe('warn');
    expect(inc?.detail).toContain('Онлайн: 211 → 0 (−100 %)');
    expect(inc?.detail).toContain('Вывод: блокировка не подтвердилась.\nВыход отвечает, а вход — нет');
    // Срок — датой в поясе панели; «через N часов» в хранимом тексте нет: оно устарело бы.
    expect(inc?.detail).toMatch(
      /💳 Срок оплаты близко: Аренда «Guardora»: 2\s500 ₽, оплачено до \d{1,2} [а-я]+( \d{4})?, \d{2}:\d{2} \((МСК|UTC[+-]\d+)\)\.\n/,
    );
    expect(inc?.detail).not.toMatch(/через \d+ час/);
    expect(inc?.detail).toContain(
      'Вероятнее всего: оплата закончилась чуть раньше срока, и вход отключили — при неоплаченной аренде вход выключают, а выход продолжает работать.',
    );
    await db.execute(sql`delete from billing_items where title = 'Guardora'`);
  });
});
