import type { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import {
  CSRF_HEADER,
  type ServerChecksResponse,
  serverChecksResponseSchema,
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
import { LLM_PROVIDER, type LlmRunInput } from '../src/modules/assistant/llm.provider.js';
import { SetupService } from '../src/modules/auth/setup.service.js';
import { FakeSsh, SSH_PASSWORD, SSH_USER } from './fake-ssh.js';

if (!process.env.DATABASE_URL?.endsWith('/nodeservice_test'))
  throw new Error('e2e: DATABASE_URL должен указывать на nodeservice_test');

const LOGIN = 'admin';
const PASSWORD = 'correct horse battery staple';

describe('server checks e2e', () => {
  let app: INestApplication;
  let agent: InstanceType<typeof TestAgent>;
  let csrf: string;
  const ssh = new FakeSsh();
  const llmCalls: LlmRunInput[] = [];
  const llm = {
    run: async (input: LlmRunInput) => {
      llmCalls.push(input);
      return {
        stopReason: 'end' as const,
        blocks: [{ type: 'text' as const, text: 'Геоблока нет, всё открывается.' }],
      };
    },
  };
  let serverId = '';

  const list = async (): Promise<ServerChecksResponse> =>
    serverChecksResponseSchema.parse((await agent.get(`/api/servers/${serverId}/checks`).expect(200)).body);
  const run = (check: string, body: Record<string, unknown> = {}, expected = 202) =>
    agent
      .post(`/api/servers/${serverId}/checks/${check}/run`)
      .set(CSRF_HEADER, csrf)
      .send(body)
      .expect(expected);
  /** Ждём, пока идущая проверка закончится (фоновая задача, опрос). */
  const waitIdle = async (): Promise<ServerChecksResponse> => {
    for (let i = 0; i < 100; i++) {
      const res = await list();
      if (!res.items.some((r) => r.status === 'running')) return res;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error('проверка не завершилась за 10 с');
  };

  beforeAll(async () => {
    await ssh.start();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(LLM_PROVIDER)
      .useValue(llm)
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
        name: 'checks-host',
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

  it('до запусков пусто; ручной запуск лёгкой проверки пишет очищенный вывод и итог в Журнал', async () => {
    expect(await list()).toEqual({ items: [], nextAutoAt: null });
    await run('geoblock');
    const res = await waitIdle();
    const geo = res.items.find((r) => r.check === 'geoblock');
    expect(geo).toMatchObject({ status: 'ok', trigger: 'manual', actorDisplay: LOGIN, error: null });
    // Цвета вырезаны, от индикатора прогресса осталось последнее состояние.
    expect(geo?.output).toBe('проверка geoblock\n100%\nготово\n');
    expect(res.nextAutoAt).not.toBeNull();
    expect(ssh.execLog.some((c) => c.startsWith('# ns-check:geoblock'))).toBe(true);
    const audit = await agent.get('/api/audit?action=server.check.run').expect(200);
    expect(JSON.stringify(audit.body)).toContain('Геоблок');
  });

  it('тяжёлая проверка без подтверждения — 400 и ничего не запускается; с подтверждением — идёт', async () => {
    const before = ssh.execLog.length;
    const denied = await run('yabs', {}, 400);
    expect(denied.body.detail).toContain('тяжёлая проверка');
    expect(ssh.execLog.length).toBe(before);
    await run('yabs', { confirmHeavy: true });
    const res = await waitIdle();
    expect(res.items.find((r) => r.check === 'yabs')?.status).toBe('ok');
  });

  it('скрипт упал по таймауту — понятная причина, вывод сохранён', async () => {
    ssh.checks.output.dpi = 'частичный вывод\n';
    ssh.checks.code.dpi = 124;
    await run('dpi');
    const res = await waitIdle();
    const dpi = res.items.find((r) => r.check === 'dpi');
    expect(dpi?.status).toBe('failed');
    expect(dpi?.error).toContain('не уложилась');
    expect(dpi?.output).toContain('частичный вывод');
  });

  it('неизвестная проверка — отказ, а не запуск', async () => {
    await run('rm-rf', {}, 422);
  });

  it('суточная джоба запускает только лёгкие проверки, которые ещё не шли, и не трогает тяжёлые', async () => {
    const { ServerChecksJob } = await import('../src/modules/server-checks/server-checks.job.js');
    await app.get(ServerChecksJob).run();
    const res = await waitIdle();
    const keys = res.items.map((r) => r.check).sort();
    expect(keys).toEqual(['cpu', 'dpi', 'geoblock', 'ip_quality', 'ip_region', 'yabs'].sort());
    expect(
      res.items
        .filter((r) => r.trigger === 'auto')
        .map((r) => r.check)
        .sort(),
    ).toEqual(['cpu', 'ip_quality', 'ip_region'].sort());
    expect(res.items.some((r) => r.check === 'iperf3_ru')).toBe(false);
  });

  it('«Объяснить»: без настроенного Джарвиса — 409; с ним — пересказ сохраняется у запуска и второй раз модель не зовётся', async () => {
    const geo = (await list()).items.find((r) => r.check === 'geoblock');
    if (!geo) throw new Error('нет запуска геоблока');
    const url = `/api/servers/${serverId}/checks/runs/${geo.id}/explain`;
    await agent.post(url).set(CSRF_HEADER, csrf).expect(409);
    await agent
      .put('/api/settings/assistant')
      .set(CSRF_HEADER, csrf)
      .send({ apiKey: 'sk-test-0123456789', model: 'anthropic/claude-sonnet-4-5' })
      .expect(200);
    const first = await agent.post(url).set(CSRF_HEADER, csrf).expect(200);
    expect(first.body.explanation).toBe('Геоблока нет, всё открывается.');
    expect(llmCalls).toHaveLength(1);
    expect(JSON.stringify(llmCalls[0]?.messages)).toContain('проверка geoblock');
    await agent.post(url).set(CSRF_HEADER, csrf).expect(200);
    expect(llmCalls).toHaveLength(1);
    expect((await list()).items.find((r) => r.id === geo.id)?.explanation).toBe(
      'Геоблока нет, всё открывается.',
    );
  });

  it('упавшую лёгкую проверку джоба повторяет через час, а не через сутки', async () => {
    const db = app.get<Db>(DB);
    await db.execute(
      sql`update server_checks set started_at = now() - interval '2 hours' where server_id = ${serverId} and "check" = 'dpi'`,
    );
    ssh.checks.code.dpi = 0;
    ssh.checks.output.dpi = 'Total: 31 OK, 0 failed\n';
    const { ServerChecksJob } = await import('../src/modules/server-checks/server-checks.job.js');
    await app.get(ServerChecksJob).run();
    const res = await waitIdle();
    expect(res.items.find((r) => r.check === 'dpi')).toMatchObject({ status: 'ok', trigger: 'auto' });
  });
});
