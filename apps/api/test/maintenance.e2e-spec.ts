import type { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import {
  CSRF_HEADER,
  type MaintenanceRun,
  type MaintenanceState,
  maintenanceRunSchema,
  maintenanceRunsResponseSchema,
  maintenanceStateSchema,
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
import { FakeSsh, SSH_PASSWORD, SSH_USER } from './fake-ssh.js';

if (!process.env.DATABASE_URL?.endsWith('/nodeservice_test'))
  throw new Error('e2e: DATABASE_URL должен указывать на nodeservice_test');

const LOGIN = 'admin';
const PASSWORD = 'correct horse battery staple';

describe('maintenance e2e', () => {
  let app: INestApplication;
  let agent: InstanceType<typeof TestAgent>;
  let csrf: string;
  const ssh = new FakeSsh();
  let serverId = '';

  const state = async (): Promise<MaintenanceState> =>
    maintenanceStateSchema.parse((await agent.get(`/api/servers/${serverId}/maintenance`).expect(200)).body);
  const start = (kind: string, expected = 202) =>
    agent
      .post(`/api/servers/${serverId}/maintenance/runs`)
      .set(CSRF_HEADER, csrf)
      .send({ kind })
      .expect(expected);
  /** Ждём, пока запуск завершится (фоновая задача, опрос состояния). */
  const waitDone = async (): Promise<MaintenanceState> => {
    for (let i = 0; i < 100; i++) {
      const st = await state();
      if (!st.running) return st;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error('обслуживание не завершилось за 10 с');
  };

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
    const startRes = await agent
      .post('/api/auth/setup/start')
      .set(CSRF_HEADER, csrf)
      .send({ setupToken, login: LOGIN, password: PASSWORD })
      .expect(200);
    await agent
      .post('/api/auth/setup/confirm')
      .set(CSRF_HEADER, csrf)
      .send({ code: await generate({ secret: startRes.body.totpSecret as string }) })
      .expect(200);

    const created = await agent
      .post('/api/servers')
      .set(CSRF_HEADER, csrf)
      .send({
        name: 'maint-host',
        host: '127.0.0.1',
        port: ssh.port,
        sshUser: SSH_USER,
        auth: { method: 'password', password: SSH_PASSWORD },
      })
      .expect(201);
    serverId = serverSchema.parse(created.body).id;
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await ssh.stop();
  });

  it('до проверки: состояние пустое, следующая проверка не назначена', async () => {
    const st = await state();
    expect(st).toMatchObject({
      serverId,
      check: null,
      checkError: null,
      nextCheckAt: null,
      running: null,
      lastRun: null,
    });
  });

  it('проверка: чек-лист из скрипта, шаги ok, Журнал, следующая через сутки', async () => {
    const run = maintenanceRunSchema.parse((await start('check')).body);
    expect(run.status).toBe('running');
    expect(run.steps.map((s) => s.key)).toEqual(['connect', 'collect', 'release']);
    // пока идёт — второй запуск получает 409
    const busy = await start('check', 409);
    expect(busy.body.type).toContain('maintenance-busy');

    const st = await waitDone();
    expect(st.check).not.toBeNull();
    expect(st.check).toMatchObject({
      supported: true,
      updates: { total: 3, security: 1 },
      rebootRequired: false,
      kernel: { running: '6.8.0-84-generic', installed: '6.8.0-85-generic' },
      unattended: false,
      agent: { installed: 'v0.5.4', latest: null, service: 'active' },
      disk: { usedPct: 16, freeMb: 66000 },
    });
    expect(st.checkError).toBeNull();
    expect(st.nextCheckAt).not.toBeNull();
    expect(new Date(st.nextCheckAt as string).getTime() - Date.now()).toBeGreaterThan(23 * 3_600_000);
    const last = st.lastRun as MaintenanceRun;
    expect(last.kind).toBe('check');
    expect(last.status).toBe('ok');
    expect(last.steps.every((s) => s.status === 'ok')).toBe(true);
    expect(last.log).toContain('Сбор данных');
    expect(last.log).toContain('Готово за');
    expect(last.actorDisplay).toBe(LOGIN);

    const audit = (await agent.get('/api/audit?page=1&pageSize=20').expect(200)).body as {
      items: Array<{ action: string; result: string; metadata: Record<string, unknown> }>;
    };
    const entry = audit.items.find((e) => e.action === 'server.maintenance.check');
    expect(entry?.result).toBe('ok');
    expect(entry?.metadata).toMatchObject({ updates: 3 });
  });

  it('обновление системы: шаги по порядку, лог, проверка после — обновлений 0 и нужна перезагрузка', async () => {
    const run = maintenanceRunSchema.parse((await start('apt_upgrade')).body);
    expect(run.steps.map((s) => s.key)).toEqual(['connect', 'update', 'upgrade', 'after']);
    const st = await waitDone();
    const last = st.lastRun as MaintenanceRun;
    expect(last.kind).toBe('apt_upgrade');
    expect(last.status).toBe('ok');
    expect(last.log).toContain('ok: apt_upgrade:update');
    expect(last.log).toContain('ok: apt_upgrade:upgrade');
    expect(last.steps.find((s) => s.key === 'after')?.detail).toContain('нужна перезагрузка');
    expect(st.check?.updates).toEqual({ total: 0, security: 0 });
    expect(st.check?.rebootRequired).toBe(true);
    // на сервере выполнялись именно неинтерактивные apt-команды
    expect(
      ssh.execLog.some(
        (c) => c.includes('apt-get -y --with-new-pkgs') && c.includes('DEBIAN_FRONTEND=noninteractive'),
      ),
    ).toBe(true);
  });

  it('ошибка шага: запуск failed, остальные шаги пропущены, лог с причиной, Журнал warn', async () => {
    ssh.maintenance.failStep = 'cleanup:clean';
    await start('cleanup');
    const st = await waitDone();
    ssh.maintenance.failStep = '';
    const last = st.lastRun as MaintenanceRun;
    expect(last.status).toBe('failed');
    expect(last.error).toContain('кодом 100');
    expect(last.steps.map((s) => `${s.key}:${s.status}`)).toEqual([
      'connect:ok',
      'autoremove:ok',
      'clean:failed',
      'journal:skipped',
      'after:skipped',
    ]);
    expect(last.log).toContain('шаг cleanup:clean сломан');
    const audit = (await agent.get('/api/audit?page=1&pageSize=20').expect(200)).body as {
      items: Array<{ action: string; result: string; severity: string }>;
    };
    const entry = audit.items.find((e) => e.action === 'server.maintenance.cleanup');
    expect(entry).toMatchObject({ result: 'failed', severity: 'warn' });
  });

  it('история запусков: свежие первыми, без логов; неизвестный вид — 400', async () => {
    const runs = maintenanceRunsResponseSchema.parse(
      (await agent.get(`/api/servers/${serverId}/maintenance/runs`).expect(200)).body,
    );
    expect(runs.items.map((r) => r.kind)).toEqual(['cleanup', 'apt_upgrade', 'check']);
    expect(runs.items.every((r) => r.log === '')).toBe(true);
    await start('reboot', 400);
  });

  it('SSH недоступен: проверка падает с понятной ошибкой и checkError, прошлый чек-лист остаётся', async () => {
    await ssh.stop();
    await start('check');
    const st = await waitDone();
    expect(st.checkError).toMatch(/SSH/);
    expect(st.check?.updates).toEqual({ total: 0, security: 0 });
    expect(st.lastRun?.status).toBe('failed');
    expect(st.lastRun?.steps[0]).toMatchObject({ key: 'connect', status: 'failed' });
    await ssh.start(ssh.port);
  }, 30_000);
});
