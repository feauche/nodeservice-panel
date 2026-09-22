import type { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import {
  auditListResponseSchema,
  CSRF_HEADER,
  incidentSchema,
  incidentsListResponseSchema,
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
import { IncidentsRepository } from '../src/modules/incidents/incidents.repository.js';
import { IncidentsService } from '../src/modules/incidents/incidents.service.js';
import { FakeSsh, SSH_PASSWORD, SSH_USER } from './fake-ssh.js';

if (!process.env.DATABASE_URL?.endsWith('/nodeservice_test'))
  throw new Error('e2e: DATABASE_URL должен указывать на nodeservice_test');

const LOGIN = 'admin';
const PASSWORD = 'correct horse battery staple';
const noMetrics = { cpu: new Map(), mem: new Map(), disk: new Map() };

describe('incidents e2e', () => {
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
    await db.execute(
      sql`truncate users, recovery_codes, trusted_devices, setup_tokens, servers, incidents cascade`,
    );
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
    const created = await agent
      .post('/api/servers')
      .set(CSRF_HEADER, csrf)
      .send({
        name: 'inc-host',
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

  it('детекция: агент офлайн → крит-инцидент; вернулся → авто-закрытие', async () => {
    const db = app.get<Db>(DB);
    const svc = app.get(IncidentsService);
    await db.execute(sql`update servers set agent_status = 'offline' where id = ${serverId}`);
    await svc.evaluate(noMetrics);

    const list = incidentsListResponseSchema.parse(
      (await agent.get('/api/incidents?status=open').expect(200)).body,
    );
    expect(list.counts.crit).toBe(1);
    const inc = list.items.find((i) => i.kind === 'agent_offline');
    expect(inc?.severity).toBe('crit');
    expect(inc?.timeline[0]?.result).toBe('detect');

    // агент вернулся → следующий тик закрывает инцидент
    await db.execute(sql`update servers set agent_status = 'online' where id = ${serverId}`);
    await svc.evaluate(noMetrics);
    const after = incidentsListResponseSchema.parse(
      (await agent.get('/api/incidents?status=open').expect(200)).body,
    );
    expect(after.items.some((i) => i.kind === 'agent_offline')).toBe(false);
    const resolved = incidentsListResponseSchema.parse(
      (await agent.get('/api/incidents?status=resolved').expect(200)).body,
    );
    expect(resolved.items.some((i) => i.kind === 'agent_offline' && i.resolvedBy === 'auto')).toBe(true);
  });

  it('автопочинка: пресет выполняется по SSH, кулдаун не пускает повтор', async () => {
    const repo = app.get(IncidentsRepository);
    const opened = await repo.open({
      serverId,
      serverName: 'inc-host',
      kind: 'cpu_high',
      severity: 'warn',
      title: 'Высокая нагрузка на CPU · inc-host',
      detail: 'CPU держится выше порога.',
      timeline: [{ at: new Date().toISOString(), by: 'auto', action: 'Обнаружено', result: 'detect' }],
    });
    const id = opened?.id ?? '';
    const before = ssh.execLog.length;
    const fixed = incidentSchema.parse(
      (
        await agent
          .post(`/api/incidents/${id}/autofix`)
          .set(CSRF_HEADER, csrf)
          .send({ preset: 'restart_xray' })
          .expect(200)
      ).body,
    );
    expect(fixed.timeline.some((e) => e.result === 'applied')).toBe(true);
    expect(ssh.execLog.length).toBeGreaterThan(before);
    expect(ssh.execLog.some((c) => c.includes('xray') || c.includes('remnanode'))).toBe(true);

    // повтор сразу — кулдаун 429
    await agent
      .post(`/api/incidents/${id}/autofix`)
      .set(CSRF_HEADER, csrf)
      .send({ preset: 'restart_xray' })
      .expect(429);

    // неподходящий пресет — 400
    await agent
      .post(`/api/incidents/${id}/autofix`)
      .set(CSRF_HEADER, csrf)
      .send({ preset: 'free_disk' })
      .expect(400);

    const audit = auditListResponseSchema.parse(
      (await agent.get('/api/audit?category=server').expect(200)).body,
    );
    expect(audit.items.some((e) => e.action === 'incident.autofix')).toBe(true);
    expect(audit.items.some((e) => e.action === 'incident.opened')).toBe(true);
  });

  it('ручное закрытие инцидента', async () => {
    const list = incidentsListResponseSchema.parse(
      (await agent.get('/api/incidents?status=open').expect(200)).body,
    );
    const cpu = list.items.find((i) => i.kind === 'cpu_high');
    expect(cpu).toBeDefined();
    const resolved = incidentSchema.parse(
      (await agent.post(`/api/incidents/${cpu?.id}/resolve`).set(CSRF_HEADER, csrf).expect(200)).body,
    );
    expect(resolved.status).toBe('resolved');
    expect(resolved.resolvedBy).toBe('manual');
  });

  it('настройки инцидентов: PUT меняет порог, diff в Журнале', async () => {
    const res = await agent
      .put('/api/settings/incidents')
      .set(CSRF_HEADER, csrf)
      .send({ cpuPct: 80 })
      .expect(200);
    expect(res.body.cpuPct).toBe(80);
    const audit = auditListResponseSchema.parse(
      (await agent.get('/api/audit?category=settings').expect(200)).body,
    );
    expect(audit.items.some((e) => e.action === 'settings.incidents.updated')).toBe(true);
  });
});
