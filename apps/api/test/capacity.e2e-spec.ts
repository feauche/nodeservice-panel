import type { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { auditListResponseSchema, CSRF_HEADER, capacitySchema, serverLinkSchema } from '@nodeservice/shared';
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
import { FakeSsh, SSH_PASSWORD, SSH_USER } from './fake-ssh.js';

if (!process.env.DATABASE_URL?.endsWith('/nodeservice_test'))
  throw new Error('e2e: DATABASE_URL должен указывать на nodeservice_test');

describe('ёмкость парка e2e', () => {
  let app: INestApplication;
  let agent: InstanceType<typeof TestAgent>;
  let csrf: string;
  const ssh = new FakeSsh();
  let serverId = '';

  beforeAll(async () => {
    await ssh.start();
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
    const created = await agent
      .post('/api/servers')
      .set(CSRF_HEADER, csrf)
      .send({
        name: 'Германия-1',
        host: '127.0.0.1',
        port: ssh.port,
        sshUser: SSH_USER,
        auth: { method: 'password', password: SSH_PASSWORD },
      })
      .expect(201);
    serverId = created.body.id as string;
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await ssh.stop();
  });

  it('без Remnawave сервер в отчёте, но не считается — и сказано почему', async () => {
    const c = capacitySchema.parse((await agent.get('/api/fleet/capacity').expect(200)).body);
    expect(c.remnawave).toBe(false);
    const s = c.servers.find((x) => x.serverId === serverId);
    expect(s).toMatchObject({ role: 'other', left: null, tone: 'mute' });
    expect(s?.note).toMatch(/Remnawave не подключена/);
  });

  it('«Пересчитать» смотрит сетевую карту: виртуальной не верим, предел соединений берём', async () => {
    const c = capacitySchema.parse(
      (await agent.post('/api/fleet/capacity/refresh').set(CSRF_HEADER, csrf).expect(200)).body,
    );
    const link = c.servers.find((x) => x.serverId === serverId)?.link;
    expect(link).toMatchObject({
      nicName: 'eth0',
      nicMbit: 10_000,
      nicVirtual: true,
      conntrackMax: 262_144,
      source: 'none',
      upMbit: null,
    });
    expect(ssh.execLog.some((cmd) => cmd.includes('@@ctmax'))).toBe(true);
  });

  it('замер: по замеру канал известен; вручную — важнее замера; убрать — снова по замеру', async () => {
    const m = serverLinkSchema.parse(
      (await agent.post(`/api/servers/${serverId}/link/measure`).set(CSRF_HEADER, csrf).expect(200)).body,
    );
    expect(m).toMatchObject({ source: 'measured', downMbit: 900, upMbit: 612 });
    const manual = serverLinkSchema.parse(
      (
        await agent
          .put(`/api/servers/${serverId}/link`)
          .set(CSRF_HEADER, csrf)
          .send({ manualMbit: 1000 })
          .expect(200)
      ).body,
    );
    expect(manual).toMatchObject({ source: 'manual', upMbit: 1000, measuredUpMbit: 612 });
    const back = serverLinkSchema.parse(
      (
        await agent
          .put(`/api/servers/${serverId}/link`)
          .set(CSRF_HEADER, csrf)
          .send({ manualMbit: null })
          .expect(200)
      ).body,
    );
    expect(back.source).toBe('measured');
    await agent
      .put(`/api/servers/${serverId}/link`)
      .set(CSRF_HEADER, csrf)
      .send({ manualMbit: 3 })
      .expect(400);
    const audit = auditListResponseSchema.parse(
      (await agent.get('/api/audit?page=1&pageSize=20').expect(200)).body,
    );
    const actions = audit.items.map((i) => i.action);
    expect(actions).toContain('server.link.measured');
    expect(actions).toContain('server.link.updated');
  });

  it('несуществующий сервер — 404, замер не блокируется', async () => {
    const missing = '0192c000-dead-7000-8000-000000000000';
    await agent.post(`/api/servers/${missing}/link/measure`).set(CSRF_HEADER, csrf).expect(404);
    await agent
      .put(`/api/servers/${missing}/link`)
      .set(CSRF_HEADER, csrf)
      .send({ manualMbit: 1000 })
      .expect(404);
  });

  it('теги: слить опечатку «noed» с «node» на всех серверах (без повтора), переименовать, убрать', async () => {
    const db = app.get<Db>(DB);
    const mk = async (name: string, tags: string[]) => {
      const r = await db.execute(
        sql`insert into servers (name, host, port, ssh_user, auth_method, tags, sort_order) values (${name}, '203.0.113.50', 22, 'root', 'panel-key', ${JSON.stringify(tags)}::jsonb, 100) returning id`,
      );
      return (r.rows[0] as { id: string }).id;
    };
    const a = await mk('tags-a', ['noed', 'exit']);
    const b = await mk('tags-b', ['node', 'noed']);
    const tagsOf = async (id: string) =>
      ((await agent.get(`/api/servers/${id}`).expect(200)).body as { tags: string[] }).tags;

    const merged = await agent
      .post('/api/servers/tags/rename')
      .set(CSRF_HEADER, csrf)
      .send({ from: 'noed', to: 'Node' })
      .expect(200);
    expect(merged.body.updated).toBe(2);
    expect(await tagsOf(a)).toEqual(['node', 'exit']);
    expect(await tagsOf(b)).toEqual(['node']);

    await agent
      .post('/api/servers/tags/rename')
      .set(CSRF_HEADER, csrf)
      .send({ from: 'exit', to: 'выход' })
      .expect(200);
    expect(await tagsOf(a)).toEqual(['node', 'выход']);
    const del = await agent
      .post('/api/servers/tags/delete')
      .set(CSRF_HEADER, csrf)
      .send({ tag: 'node' })
      .expect(200);
    expect(del.body.updated).toBe(2);
    expect(await tagsOf(b)).toEqual([]);

    const audit = auditListResponseSchema.parse(
      (await agent.get('/api/audit?page=1&pageSize=20').expect(200)).body,
    );
    const acts = audit.items.map((i) => i.action);
    expect(acts).toContain('server.tags.renamed');
    expect(acts).toContain('server.tags.deleted');
  });
});
