import type { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import {
  AUTH_PROBLEM,
  auditListResponseSchema,
  CSRF_HEADER,
  SERVER_PROBLEM,
  serverSchema,
  serversResponseSchema,
} from '@nodeservice/shared';
import { sql } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import { generate } from 'otplib';
import { utils as sshUtils } from 'ssh2';
import request from 'supertest';
import TestAgent from 'supertest/lib/agent.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AppModule } from '../src/app.module.js';
import { setupHttp } from '../src/common/http/setup-http.js';
import { DB, type Db } from '../src/infra/db/db.module.js';
import { runMigrations } from '../src/infra/db/migrate.js';
import { VALKEY } from '../src/infra/valkey/valkey.module.js';
import { SessionStore } from '../src/modules/auth/session.store.js';
import { SetupService } from '../src/modules/auth/setup.service.js';
import { UsersRepository } from '../src/modules/auth/users.repository.js';
import { FakeSsh, SSH_PASSWORD, SSH_USER } from './fake-ssh.js';

if (!process.env.DATABASE_URL?.endsWith('/nodeservice_test'))
  throw new Error('e2e: DATABASE_URL должен указывать на nodeservice_test');

const LOGIN = 'admin';
const PASSWORD = 'correct horse battery staple';

describe('servers e2e', () => {
  let app: INestApplication;
  let agent: InstanceType<typeof TestAgent>;
  let csrf: string;
  let userId: string;
  const ssh = new FakeSsh();
  let serverId = '';

  const creds = () => ({ host: '127.0.0.1', port: ssh.port, sshUser: SSH_USER });

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
      .send({ setupToken, login: LOGIN, password: PASSWORD })
      .expect(200);
    await agent
      .post('/api/auth/setup/confirm')
      .set(CSRF_HEADER, csrf)
      .send({ code: await generate({ secret: start.body.totpSecret as string }) })
      .expect(200);
    userId = (await app.get(UsersRepository).findByLogin(LOGIN))?.id ?? '';
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await ssh.stop();
  });

  it('панель отдаёт свой публичный ключ (стабильный между вызовами)', async () => {
    const a = (await agent.get('/api/servers/panel-key').expect(200)).body.publicKey as string;
    const b = (await agent.get('/api/servers/panel-key').expect(200)).body.publicKey as string;
    expect(a).toMatch(/^ssh-ed25519 AAAA[\w+/=]+ nodeservice-panel$/);
    expect(b).toBe(a);
    const parsed = sshUtils.parseKey(a);
    expect(parsed instanceof Error).toBe(false);
  });

  it('test: проверка доступов возвращает отпечаток и факты; неверный пароль и мёртвый порт — понятные ошибки', async () => {
    const ok = await agent
      .post('/api/servers/test')
      .set(CSRF_HEADER, csrf)
      .send({ ...creds(), auth: { method: 'password', password: SSH_PASSWORD } })
      .expect(200);
    expect(ok.body.hostKeyFingerprint).toMatch(/^SHA256:/);
    expect(ok.body.facts).toMatchObject({
      os: 'Ubuntu',
      osVersion: '24.04',
      arch: 'x86_64',
      cpuCores: 4,
      memoryMb: 8000,
    });

    const badAuth = await agent
      .post('/api/servers/test')
      .set(CSRF_HEADER, csrf)
      .send({ ...creds(), auth: { method: 'password', password: 'wrong' } })
      .expect(400);
    expect(badAuth.body.type).toBe(SERVER_PROBLEM.sshAuth);

    const dead = await agent
      .post('/api/servers/test')
      .set(CSRF_HEADER, csrf)
      .send({ host: '127.0.0.1', port: 1, sshUser: SSH_USER, auth: { method: 'password', password: 'x' } })
      .expect(502);
    expect(dead.body.type).toBe(SERVER_PROBLEM.sshUnreachable);
  }, 30_000);

  it('создание по паролю: ключ панели ставится и проверяется, пароль не сохраняется', async () => {
    const res = await agent
      .post('/api/servers')
      .set(CSRF_HEADER, csrf)
      .send({
        name: 'de-fra-01',
        ...creds(),
        auth: { method: 'password', password: SSH_PASSWORD },
        tags: ['prod', 'de'],
      })
      .expect(201);
    const server = serverSchema.parse(res.body);
    serverId = server.id;
    expect(server).toMatchObject({
      name: 'de-fra-01',
      authMethod: 'panel-key',
      agentStatus: 'not_installed',
      sshOk: true,
      tags: ['prod', 'de'],
    });
    expect(server.facts.os).toBe('Ubuntu');
    expect(server.hostKeyFingerprint).toMatch(/^SHA256:/);
    expect(ssh.installedKeys).toHaveLength(1);
    expect(ssh.installedKeys[0]).toContain('ssh-ed25519');

    // пароль нигде не остался
    const db = app.get<Db>(DB);
    const rows = await db.execute<{ ssh_private_key_enc: string | null }>(
      sql`select ssh_private_key_enc from servers`,
    );
    expect(rows.rows[0]?.ssh_private_key_enc).toBeNull();

    const audit = auditListResponseSchema.parse(
      (await agent.get('/api/audit?category=server').expect(200)).body,
    );
    const created = audit.items.find((e) => e.action === 'server.created');
    expect(created?.targetDisplay).toBe('de-fra-01');
    expect(JSON.stringify(audit)).not.toContain(SSH_PASSWORD);
  }, 30_000);

  it('дубль имени — 409 с полем (одинаковый адрес легален: нужен «Дублировать»)', async () => {
    const name = await agent
      .post('/api/servers')
      .set(CSRF_HEADER, csrf)
      .send({
        name: 'de-fra-01',
        host: '203.0.113.9',
        port: 22,
        sshUser: SSH_USER,
        auth: { method: 'panel-key' },
      })
      .expect(409);
    expect(name.body.type).toBe(SERVER_PROBLEM.nameTaken);
  });

  it('список и карточка; повторная проверка по ключу панели с пиннингом', async () => {
    const list = serversResponseSchema.parse((await agent.get('/api/servers').expect(200)).body);
    expect(list.items).toHaveLength(1);
    const checked = serverSchema.parse(
      (await agent.post(`/api/servers/${serverId}/check`).set(CSRF_HEADER, csrf).expect(200)).body,
    );
    expect(checked.sshOk).toBe(true);
    expect(checked.facts.hostname).toBe('test-node');
  }, 30_000);

  it('«переустановка» сервера: check → 409 с новым отпечатком, trust с чужим fp — 409, с новым — 200', async () => {
    await ssh.reinstall();
    const mismatch = await agent.post(`/api/servers/${serverId}/check`).set(CSRF_HEADER, csrf).expect(409);
    expect(mismatch.body.type).toBe(SERVER_PROBLEM.hostKeyMismatch);
    const offered = mismatch.body.offeredFingerprint as string;
    expect(offered).toMatch(/^SHA256:/);
    // sshOk сброшен, попытка — в Журнале
    const after = serverSchema.parse((await agent.get(`/api/servers/${serverId}`).expect(200)).body);
    expect(after.sshOk).toBe(false);
    // «переустановка» стёрла authorized_keys — возвращаем ключ панели, как сделал бы админ паролем
    const panelPub = (await agent.get('/api/servers/panel-key').expect(200)).body.publicKey as string;
    ssh.installedKeys.push(panelPub);

    const wrong = await agent
      .post(`/api/servers/${serverId}/trust-host-key`)
      .set(CSRF_HEADER, csrf)
      .send({ fingerprint: 'SHA256:definitely-not-this' })
      .expect(409);
    expect(wrong.body.type).toBe(SERVER_PROBLEM.hostKeyMismatch);

    const trusted = serverSchema.parse(
      (
        await agent
          .post(`/api/servers/${serverId}/trust-host-key`)
          .set(CSRF_HEADER, csrf)
          .send({ fingerprint: offered })
          .expect(200)
      ).body,
    );
    expect(trusted.hostKeyFingerprint).toBe(offered);
    expect(trusted.sshOk).toBe(true);
    await agent.post(`/api/servers/${serverId}/check`).set(CSRF_HEADER, csrf).expect(200);

    const audit = auditListResponseSchema.parse(
      (await agent.get('/api/audit?category=server').expect(200)).body,
    );
    expect(audit.items.some((e) => e.action === 'server.host_key.trusted')).toBe(true);
    expect(audit.items.some((e) => e.action === 'server.ssh.checked' && e.result === 'failed')).toBe(true);
  }, 30_000);

  it('изменение адреса сбрасывает отпечаток; diff в Журнале', async () => {
    const updated = serverSchema.parse(
      (
        await agent
          .patch(`/api/servers/${serverId}`)
          .set(CSRF_HEADER, csrf)
          .send({ name: 'de-fra-02', host: '203.0.113.50' })
          .expect(200)
      ).body,
    );
    expect(updated.name).toBe('de-fra-02');
    expect(updated.hostKeyFingerprint).toBeNull();
    expect(updated.sshOk).toBeNull();
    // вернём обратно и восстановим доверие
    await agent
      .patch(`/api/servers/${serverId}`)
      .set(CSRF_HEADER, csrf)
      .send({ host: '127.0.0.1' })
      .expect(200);
    await agent.post(`/api/servers/${serverId}/check`).set(CSRF_HEADER, csrf).expect(200);
    const audit = auditListResponseSchema.parse(
      (await agent.get('/api/audit?category=server').expect(200)).body,
    );
    const upd = audit.items.find((e) => e.action === 'server.updated' && e.changes?.name);
    expect(upd?.changes?.name).toEqual({ before: 'de-fra-01', after: 'de-fra-02' });
  }, 30_000);

  it('изменение доступов: PATCH с паролем ставит ключ панели заново и обновляет отпечаток', async () => {
    const updated = serverSchema.parse(
      (
        await agent
          .patch(`/api/servers/${serverId}`)
          .set(CSRF_HEADER, csrf)
          .send({ auth: { method: 'password', password: SSH_PASSWORD } })
          .expect(200)
      ).body,
    );
    expect(updated.authMethod).toBe('panel-key');
    expect(updated.sshOk).toBe(true);
    expect(updated.hostKeyFingerprint).toMatch(/^SHA256:/);
    await agent
      .patch(`/api/servers/${serverId}`)
      .set(CSRF_HEADER, csrf)
      .send({ auth: { method: 'password', password: 'wrong' } })
      .expect(400);
  }, 30_000);

  it('токен агента: выпуск за step-up, повтор отзывает старый', async () => {
    const t1 = (
      await agent.post(`/api/servers/${serverId}/enrollment-token`).set(CSRF_HEADER, csrf).expect(200)
    ).body;
    expect(t1.token).toMatch(/^nse_/);
    expect(t1.installCommand).toContain(t1.token);
    const t2 = (
      await agent.post(`/api/servers/${serverId}/enrollment-token`).set(CSRF_HEADER, csrf).expect(200)
    ).body;
    expect(t2.token).not.toBe(t1.token);
    const audit = auditListResponseSchema.parse(
      (await agent.get('/api/audit?category=server').expect(200)).body,
    );
    const issued = audit.items.filter((e) => e.action === 'server.enrollment.issued');
    expect(issued.length).toBeGreaterThanOrEqual(2);
    expect(issued[0]?.metadata.replacedTokens).toBe(1);
    expect(JSON.stringify(audit)).not.toContain(t2.token);
    const state = serverSchema.parse((await agent.get(`/api/servers/${serverId}`).expect(200)).body);
    // pending — от фоновой автоустановки при добавлении сервера; сам выпуск токена статус не меняет
    expect(state.agentStatus).toBe('pending');
  });

  it('дублирование: копия записи с номером -2/-3, копия живая по ключу панели', async () => {
    const dup = serverSchema.parse(
      (await agent.post(`/api/servers/${serverId}/duplicate`).set(CSRF_HEADER, csrf).expect(201)).body,
    );
    expect(dup.name).toBe('de-fra-02-2');
    expect(dup.id).not.toBe(serverId);
    expect(dup).toMatchObject({ sshUser: SSH_USER, authMethod: 'panel-key', agentStatus: 'not_installed' });
    const dup2 = serverSchema.parse(
      (await agent.post(`/api/servers/${dup.id}/duplicate`).set(CSRF_HEADER, csrf).expect(201)).body,
    );
    expect(dup2.name).toBe('de-fra-02-3');
    const checked = serverSchema.parse(
      (await agent.post(`/api/servers/${dup.id}/check`).set(CSRF_HEADER, csrf).expect(200)).body,
    );
    expect(checked.sshOk).toBe(true);
    const audit = auditListResponseSchema.parse(
      (await agent.get('/api/audit?category=server').expect(200)).body,
    );
    expect(audit.items.filter((e) => e.action === 'server.duplicated').length).toBeGreaterThanOrEqual(2);
    const reordered = serversResponseSchema.parse(
      (
        await agent
          .post('/api/servers/reorder')
          .set(CSRF_HEADER, csrf)
          .send({ ids: [dup2.id, serverId, dup.id] })
          .expect(200)
      ).body,
    );
    expect(reordered.items.map((s) => s.name)).toEqual(['de-fra-02-3', 'de-fra-02', 'de-fra-02-2']);
    // копии не мешают дальнейшим тестам: удаляем
    await agent.delete(`/api/servers/${dup.id}`).set(CSRF_HEADER, csrf).expect(204);
    await agent.delete(`/api/servers/${dup2.id}`).set(CSRF_HEADER, csrf).expect(204);
  }, 30_000);

  it('удаление: без свежего пароля — 403 step-up, после unlock — 204', async () => {
    const sessions = app.get(SessionStore);
    const [session] = await sessions.listForUser(userId);
    if (!session) throw new Error('нет сессии');
    await sessions.setStepUp(session.id, new Date(Date.now() - 10 * 60_000));
    const denied = await agent.delete(`/api/servers/${serverId}`).set(CSRF_HEADER, csrf).expect(403);
    expect(denied.body.type).toBe(AUTH_PROBLEM.stepUp);
    await agent.post('/api/auth/unlock').set(CSRF_HEADER, csrf).send({ password: PASSWORD }).expect(200);
    await agent.delete(`/api/servers/${serverId}`).set(CSRF_HEADER, csrf).expect(204);
    await agent.get(`/api/servers/${serverId}`).expect(404);
    const audit = auditListResponseSchema.parse(
      (await agent.get('/api/audit?category=server').expect(200)).body,
    );
    expect(audit.items.some((e) => e.action === 'server.deleted')).toBe(true);
  });

  it('добавление без проверки: ключ панели — мгновенно и «не проверен», пароль — отказ', async () => {
    const res = await agent
      .post('/api/servers')
      .set(CSRF_HEADER, csrf)
      .send({
        name: 'unverified-01',
        host: '203.0.113.50',
        port: 22,
        sshUser: SSH_USER,
        auth: { method: 'panel-key' },
        verify: false,
      })
      .expect(201);
    const created = serverSchema.parse(res.body);
    expect(created.sshOk).toBeNull();
    expect(created.hostKeyFingerprint).toBeNull();
    expect(created.facts.os).toBeNull();

    const bad = await agent
      .post('/api/servers')
      .set(CSRF_HEADER, csrf)
      .send({
        name: 'unverified-02',
        host: '203.0.113.51',
        port: 22,
        sshUser: SSH_USER,
        auth: { method: 'password', password: 'whatever' },
        verify: false,
      })
      .expect(400);
    expect(JSON.stringify(bad.body.errors ?? [])).toContain('password');
    await agent.delete(`/api/servers/${created.id}`).set(CSRF_HEADER, csrf).expect(204);
  });

  it('без сессии всё закрыто', async () => {
    await request(app.getHttpServer()).get('/api/servers').expect(401);
    await request(app.getHttpServer()).get('/api/servers/panel-key').expect(401);
  });
});
