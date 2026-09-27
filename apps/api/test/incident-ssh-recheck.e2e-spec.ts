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
import { IncidentSshRecheckJob } from '../src/modules/incidents/incident-ssh-recheck.job.js';
import { IncidentsRepository } from '../src/modules/incidents/incidents.repository.js';
import { FakeSsh, SSH_PASSWORD, SSH_USER } from './fake-ssh.js';

const LOGIN = 'admin';
const PASSWORD = 'correct horse battery staple';
/** Порт, где заведомо никто не слушает: как в servers.e2e-spec.ts для проверки SERVER_PROBLEM.sshUnreachable. */
const DEAD_PORT = 1;

if (!process.env.DATABASE_URL?.endsWith('/nodeservice_test'))
  throw new Error('e2e: DATABASE_URL должен указывать на nodeservice_test');

describe('ускоренная перепроверка SSH при открытом инциденте (e2e)', () => {
  let app: INestApplication;
  let agent: InstanceType<typeof TestAgent>;
  let csrf: string;
  const ssh = new FakeSsh();
  let target: Server;

  const setChecked = (id: string, minutesAgo: number) =>
    app
      .get<Db>(DB)
      .execute(
        sql`update servers set last_ssh_check_at = now() - (${minutesAgo} * interval '1 minute') where id = ${id}`,
      );
  const setPort = (id: string, port: number) =>
    app.get<Db>(DB).execute(sql`update servers set port = ${port} where id = ${id}`);
  const getServer = async (id: string) =>
    serverSchema.parse((await agent.get(`/api/servers/${id}`).expect(200)).body);

  beforeAll(async () => {
    await ssh.start();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication<NestExpressApplication>({ bufferLogs: false, logger: false });
    setupHttp(app as NestExpressApplication);
    const db = app.get<Db>(DB);
    await runMigrations(db);
    await db.execute(
      sql`truncate users, recovery_codes, trusted_devices, setup_tokens, servers, incidents cascade`,
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
    target = serverSchema.parse(
      (
        await agent
          .post('/api/servers')
          .set(CSRF_HEADER, csrf)
          .send({
            name: 'recheck-target',
            host: '127.0.0.1',
            port: ssh.port,
            sshUser: SSH_USER,
            auth: { method: 'password', password: SSH_PASSWORD },
          })
          .expect(201)
      ).body,
    );
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    await ssh.stop();
  });

  it('без открытого инцидента джоба ничего не проверяет', async () => {
    await setChecked(target.id, 999);
    const before = (await getServer(target.id)).lastSshCheckAt;
    await app.get(IncidentSshRecheckJob).run();
    expect((await getServer(target.id)).lastSshCheckAt).toBe(before);
  });

  it('пока «SSH недоступен» открыт: сервер перепроверяется, а как только SSH снова отвечает — доступ виден без ручной кнопки', async () => {
    const row = await app.get(IncidentsRepository).open({
      serverId: target.id,
      serverName: target.name,
      kind: 'ssh_down',
      severity: 'crit',
      title: 'SSH недоступен',
      detail: 'Панель не может подключиться по SSH.',
      timeline: [{ at: new Date().toISOString(), by: 'auto', action: 'Обнаружено', result: 'detect' }],
    });
    // «Сервер упал»: адрес указывает туда, где заведомо никто не слушает — как в servers.e2e-spec.ts.
    await setPort(target.id, DEAD_PORT);
    await app.get<Db>(DB).execute(sql`update servers set ssh_ok = false where id = ${target.id}`);
    await setChecked(target.id, 999);

    await app.get(IncidentSshRecheckJob).run();
    let s = await getServer(target.id);
    expect(s.sshOk).toBe(false);
    expect(s.lastSshCheckAt).not.toBeNull();
    const checkedWhileDown = s.lastSshCheckAt;

    // «Сервер поднялся»: адрес возвращается на настоящий фейковый SSH.
    await setPort(target.id, ssh.port);
    await setChecked(target.id, 999);
    await app.get(IncidentSshRecheckJob).run();
    s = await getServer(target.id);
    expect(s.sshOk).toBe(true);
    expect(s.lastSshCheckAt).not.toBe(checkedWhileDown);

    // Не долбит чаще минимального промежутка: тик сразу следом ничего не меняет.
    const after = s.lastSshCheckAt;
    await app.get(IncidentSshRecheckJob).run();
    expect((await getServer(target.id)).lastSshCheckAt).toBe(after);

    await app.get(IncidentsRepository).delete(row?.id ?? '');
  });
});
