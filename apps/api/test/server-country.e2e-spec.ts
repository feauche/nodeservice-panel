import type { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { CSRF_HEADER, type Server, serverSchema } from '@nodeservice/shared';
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
import { GEO_LOOKUP, type GeoAnswers, type GeoLookup } from '../src/modules/servers/geo.lookup.js';
import { ServerCountryService } from '../src/modules/servers/server-country.service.js';
import { FakeSsh, SSH_PASSWORD, SSH_USER } from './fake-ssh.js';

if (!process.env.DATABASE_URL?.endsWith('/nodeservice_test'))
  throw new Error('e2e: DATABASE_URL должен указывать на nodeservice_test');

const LOGIN = 'admin';
const PASSWORD = 'correct horse battery staple';

/** Геосервисы вместо сети: что ответить и к каким адресам обращались. */
class FakeGeo implements GeoLookup {
  answers: string[] = ['PL', 'PL', 'PL', 'PL', 'BR', 'RU', 'PL'];
  hosts: string[] = [];
  async detect(host: string): Promise<GeoAnswers> {
    this.hosts.push(host);
    return { ip: host, answers: this.answers, asked: 7 };
  }
}

describe('страна сервера e2e', () => {
  let app: INestApplication;
  let agent: InstanceType<typeof TestAgent>;
  let csrf: string;
  const ssh = new FakeSsh();
  const geo = new FakeGeo();
  let n = 0;

  const add = async (extra: Record<string, unknown> = {}): Promise<Server> => {
    n += 1;
    const res = await agent
      .post('/api/servers')
      .set(CSRF_HEADER, csrf)
      .send({
        name: `geo-${n}-srv`,
        host: '127.0.0.1',
        port: ssh.port,
        sshUser: SSH_USER,
        auth: { method: 'password', password: SSH_PASSWORD },
        ...extra,
      });
    if (res.status !== 201) throw new Error(`создание: ${res.status} ${JSON.stringify(res.body)}`);
    return serverSchema.parse(res.body);
  };
  const get = async (id: string) =>
    serverSchema.parse((await agent.get(`/api/servers/${id}`).expect(200)).body);
  const patch = (id: string, body: Record<string, unknown>) =>
    agent.patch(`/api/servers/${id}`).set(CSRF_HEADER, csrf).send(body);
  const settled = async (id: string, status = 'ok') => {
    for (let i = 0; i < 100; i += 1) {
      const s = await get(id);
      if (s.country.status === status) return s;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`страна не дошла до «${status}»`);
  };
  const audit = async () => JSON.stringify((await agent.get('/api/audit?pageSize=100').expect(200)).body);

  beforeAll(async () => {
    await ssh.start();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(GEO_LOOKUP)
      .useValue(geo)
      .compile();
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
    await ssh.stop();
  });

  it('без страны при добавлении: «определяется», затем страна по большинству источников и запись в Журнале', async () => {
    const created = await add();
    expect(created.country).toMatchObject({ source: 'auto', status: 'detecting', code: null });
    const done = await settled(created.id);
    expect(done.country).toMatchObject({
      code: 'PL',
      source: 'auto',
      status: 'ok',
      agree: 5,
      total: 7,
      note: null,
    });
    expect(done.country.checkedAt).not.toBeNull();
    expect(await audit()).toContain('server.country.detected');
    expect(geo.hosts).toContain('127.0.0.1');
  });

  it('страна выбрана вручную при добавлении: геосервисы не спрашиваются, код приводится к верхнему регистру', async () => {
    const before = geo.hosts.length;
    const created = await add({ country: { mode: 'manual', code: 'nl' } });
    expect(created.country).toMatchObject({ code: 'NL', source: 'manual', status: 'ok' });
    await new Promise((r) => setTimeout(r, 200));
    expect(geo.hosts).toHaveLength(before);
    expect((await get(created.id)).country.code).toBe('NL');
  });

  it('неверный код страны и неизвестный режим отклоняются', async () => {
    const s = await add({ country: { mode: 'manual', code: 'FI' } });
    for (const bad of [{ mode: 'manual', code: 'ZZ' }, { mode: 'manual' }, { mode: 'guess' }, { code: 'PL' }])
      expect([400, 422], JSON.stringify(bad)).toContain((await patch(s.id, { country: bad })).status);
    expect((await get(s.id)).country.code).toBe('FI');
  });

  it('смена режима: вручную, потом «Определять автоматически» заново запускает определение', async () => {
    const s = await add({ country: { mode: 'manual', code: 'FI' } });
    let res = await patch(s.id, { country: { mode: 'manual', code: 'de' } }).expect(200);
    expect(serverSchema.parse(res.body).country).toMatchObject({
      code: 'DE',
      source: 'manual',
      status: 'ok',
    });
    geo.answers = ['RU', 'RU', 'RU', 'RU', 'RU', 'PL'];
    res = await patch(s.id, { country: { mode: 'auto' } }).expect(200);
    expect(serverSchema.parse(res.body).country).toMatchObject({ source: 'auto', status: 'detecting' });
    const done = await settled(s.id);
    expect(done.country).toMatchObject({ code: 'RU', source: 'auto', agree: 5, total: 6 });
    expect(await audit()).toContain('server.country.changed');
    geo.answers = ['PL', 'PL', 'PL', 'PL', 'BR', 'RU', 'PL'];
  });

  it('не удалось определить: статус «failed» с причиной, прежняя страна остаётся', async () => {
    const s = await add({ country: { mode: 'manual', code: 'FI' } });
    geo.answers = ['PL', 'BR'];
    await patch(s.id, { country: { mode: 'auto' } }).expect(200);
    const failed = await settled(s.id, 'failed');
    expect(failed.country.code).toBe('FI');
    expect(failed.country.note).toContain('Ответили только 2');
    geo.answers = ['PL', 'PL', 'PL', 'PL', 'BR', 'RU', 'PL'];
    await patch(s.id, { country: { mode: 'auto' } }).expect(200);
    expect((await settled(s.id)).country).toMatchObject({ code: 'PL', status: 'ok', note: null });
  });

  it('смена адреса при автоопределении запускает определение заново, при ручном выборе страна остаётся', async () => {
    const auto = await settled((await add()).id);
    const manual = await add({ country: { mode: 'manual', code: 'US' } });
    geo.hosts.length = 0;
    geo.answers = ['DE', 'DE', 'DE', 'DE', 'DE', 'PL', 'PL'];
    await patch(auto.id, { host: '127.0.0.2' }).expect(200);
    await patch(manual.id, { host: '127.0.0.3' }).expect(200);
    const done = await settled(auto.id);
    expect(done.country.code).toBe('DE');
    expect(geo.hosts).toEqual(['127.0.0.2']);
    expect((await get(manual.id)).country).toMatchObject({ code: 'US', source: 'manual' });
    geo.answers = ['PL', 'PL', 'PL', 'PL', 'BR', 'RU', 'PL'];
  });

  it('копия сервера наследует страну и режим', async () => {
    const s = await add({ country: { mode: 'manual', code: 'SE' } });
    const copy = serverSchema.parse(
      (await agent.post(`/api/servers/${s.id}/duplicate`).set(CSRF_HEADER, csrf).expect(201)).body,
    );
    expect(copy.country).toMatchObject({ code: 'SE', source: 'manual', status: 'ok' });
  });

  it('плановая перепроверка: другая страна меняется только после подтверждения подряд, ручная не трогается', async () => {
    const svc = app.get(ServerCountryService);
    const s = await settled((await add()).id);
    expect(s.country.code).toBe('PL');
    // Фоновое определение после сохранения ещё пишет в Журнал: даём ему закончиться, чтобы плановый запуск не упёрся в замок.
    await new Promise((r) => setTimeout(r, 200));
    geo.answers = ['FR', 'FR', 'FR', 'FR', 'FR', 'PL', 'PL'];
    await svc.detect(s.id, { scheduled: true });
    expect((await get(s.id)).country.code).toBe('PL');
    await svc.detect(s.id, { scheduled: true });
    expect((await get(s.id)).country).toMatchObject({ code: 'FR', status: 'ok' });
    const manual = await add({ country: { mode: 'manual', code: 'IT' } });
    await svc.detect(manual.id, { scheduled: true });
    expect((await get(manual.id)).country.code).toBe('IT');
    geo.answers = ['PL', 'PL', 'PL', 'PL', 'BR', 'RU', 'PL'];
  });

  it('список серверов отдаёт страну каждого', async () => {
    const list = (await agent.get('/api/servers').expect(200)).body.items as Array<{
      country: { source: string };
    }>;
    expect(list.length).toBeGreaterThan(3);
    for (const s of list) expect(['auto', 'manual']).toContain(s.country.source);
  });
});
