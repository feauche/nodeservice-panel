import type { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { AUTH_PROBLEM, type AuditEntry, auditListResponseSchema, CSRF_HEADER } from '@nodeservice/shared';
import { sql } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import { generate } from 'otplib';
import type { Pool } from 'pg';
import request from 'supertest';
import TestAgent from 'supertest/lib/agent.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AppModule } from '../src/app.module.js';
import { setupHttp } from '../src/common/http/setup-http.js';
import { DB, type Db, PG_POOL } from '../src/infra/db/db.module.js';
import { runMigrations } from '../src/infra/db/migrate.js';
import { VALKEY } from '../src/infra/valkey/valkey.module.js';
import { AuditEvents } from '../src/modules/audit/audit.events.js';
import { AuditRepository } from '../src/modules/audit/audit.repository.js';
import { AuditService } from '../src/modules/audit/audit.service.js';
import { AuditPartitionsService } from '../src/modules/audit/audit-partitions.service.js';
import { SetupService } from '../src/modules/auth/setup.service.js';

if (!process.env.DATABASE_URL?.endsWith('/nodeservice_test'))
  throw new Error('e2e: DATABASE_URL должен указывать на nodeservice_test');

const LOGIN = 'admin';
const PASSWORD = 'correct horse battery staple';

describe('audit e2e', () => {
  let app: INestApplication;
  let db: Db;
  let agent: InstanceType<typeof TestAgent>;
  let csrf: string;

  const post = (url: string, body: unknown) => agent.post(url).set(CSRF_HEADER, csrf).send(body);

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication<NestExpressApplication>({ bufferLogs: false, logger: false });
    setupHttp(app as NestExpressApplication);
    db = app.get<Db>(DB);
    await runMigrations(db);
    await db.execute(sql`truncate users, recovery_codes, trusted_devices, setup_tokens cascade`);
    // Настройки из прошлых прогонов: иначе PUT без изменений даст пустой diff.
    await db.execute(sql`delete from app_meta where key like 'settings.%'`);
    // Журнал append-only: чистим только пересозданием разделов текущего теста.
    for (const p of await listPartitionNames(db)) await db.execute(sql.raw(`DROP TABLE "${p}"`));
    await app.get<Redis>(VALKEY).flushdb();
    await app.init();
    agent = request.agent(app.getHttpServer());
    csrf = (await agent.get('/api/auth/csrf').expect(200)).body.token as string;

    // Первый запуск через API — чтобы записи входа были настоящими (IP, UA, request id).
    const setupToken = await app.get(SetupService).issueToken();
    const start = await post('/api/auth/setup/start', {
      setupToken,
      login: LOGIN,
      password: PASSWORD,
    }).expect(200);
    await post('/api/auth/setup/confirm', {
      code: await generate({ secret: start.body.totpSecret as string }),
    })
      .set('user-agent', 'audit-e2e/1.0')
      .expect(200);
  });

  afterAll(async () => {
    await app?.close();
  });

  it('без сессии Журнал закрыт', async () => {
    const res = await request(app.getHttpServer()).get('/api/audit').expect(401);
    expect(res.body.type).toBe(AUTH_PROBLEM.unauthenticated);
  });

  it('отказы до обработчика тоже в Журнале: CSRF и запрос без входа; GET без входа — не шумит', async () => {
    // CSRF: заголовка нет → 403 из middleware, но запись есть.
    await agent.post('/api/settings/appearance').send({ brandName: 'x' }).expect(403);
    // Без сессии на изменяющий запрос → 401 из guard-а, запись есть.
    const anon = request.agent(app.getHttpServer());
    const anonCsrf = (await anon.get('/api/auth/csrf').expect(200)).body.token as string;
    await anon
      .post('/api/servers/00000000-0000-4000-8000-000000000000/check')
      .set(CSRF_HEADER, anonCsrf)
      .expect(401);
    // GET без сессии — 401, но в Журнал не пишем (опросы протухшей вкладки).
    await anon.get('/api/servers').expect(401);
    await new Promise((r) => setTimeout(r, 300));
    const body = auditListResponseSchema.parse(
      (await agent.get('/api/audit?result=denied').expect(200)).body,
    );
    const csrfDenied = body.items.find((e) => e.action === 'auth.csrf.denied');
    expect(csrfDenied).toMatchObject({ result: 'denied', category: 'auth' });
    expect(csrfDenied?.metadata).toMatchObject({ method: 'POST', path: '/api/settings/appearance' });
    const noSession = body.items.filter((e) => e.action === 'auth.request.denied');
    expect(noSession).toHaveLength(1);
    expect(noSession[0]?.metadata).toMatchObject({ reason: 'unauthenticated', method: 'POST' });
  });

  it('события входа попадают в Журнал с актором, IP и request id', async () => {
    const res = await agent.get('/api/audit?category=auth').expect(200);
    const body = auditListResponseSchema.parse(res.body);
    expect(body.total).toBeGreaterThan(0);
    const setup = body.items.find((e) => e.action === 'auth.setup.completed');
    expect(setup).toBeDefined();
    expect(setup).toMatchObject({
      actorType: 'admin',
      actorDisplay: LOGIN,
      result: 'ok',
      source: 'manual',
      category: 'auth',
      userAgent: 'audit-e2e/1.0',
    });
    expect(setup?.ip).toBeTruthy();
    expect(setup?.requestId).toBeTruthy();
    expect(setup?.metadata).toMatchObject({ login: LOGIN, amr: ['pwd', 'totp'] });
    // новые сверху
    const seqs = body.items.map((e) => e.seq);
    expect([...seqs].sort((a, b) => b - a)).toEqual(seqs);
  });

  it('раздел «Первый запуск» создал разделы на текущий месяц и вперёд', async () => {
    const names = (await app.get(AuditPartitionsService).listPartitions()).map((p) => p.name);
    const now = new Date();
    const current = `audit_log_y${now.getUTCFullYear()}m${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
    expect(names).toContain(current);
    expect(names.length).toBeGreaterThanOrEqual(3);
  });

  it('@Audit на PUT настроек: запись с diff, актором сессии и длительностью', async () => {
    await agent
      .put('/api/settings/appearance')
      .set(CSRF_HEADER, csrf)
      .send({ brandName: 'Audit[#accent]Test' })
      .expect(200);
    const res = await agent.get('/api/audit?category=settings&pageSize=5').expect(200);
    const body = auditListResponseSchema.parse(res.body);
    const entry = body.items[0];
    expect(entry).toMatchObject({
      action: 'settings.appearance.updated',
      actorType: 'admin',
      actorDisplay: LOGIN,
      result: 'ok',
      targetType: 'settings',
      targetDisplay: 'Внешний вид',
    });
    expect(entry?.changes?.brandName?.after).toBe('Audit[#accent]Test');
    expect(typeof entry?.durationMs).toBe('number');

    // неудачный запрос (валидация) → result failed, статус в metadata
    await agent
      .put('/api/settings/appearance')
      .set(CSRF_HEADER, csrf)
      .send({ logoUrl: 'javascript:1' })
      .expect(400);
    const after = auditListResponseSchema.parse(
      (await agent.get('/api/audit?category=settings').expect(200)).body,
    );
    expect(after.items[0]).toMatchObject({
      action: 'settings.appearance.updated',
      result: 'failed',
      severity: 'warn',
    });
    expect(after.items[0]?.metadata).toMatchObject({ status: 400 });
  });

  it('фильтры, поиск и номерная пагинация', async () => {
    const all = auditListResponseSchema.parse((await agent.get('/api/audit?pageSize=5').expect(200)).body);
    expect(all.items.length).toBeLessThanOrEqual(5);
    expect(all.totalPages).toBe(Math.ceil(all.total / 5));
    // страница за пределами — подрезается до последней
    const last = auditListResponseSchema.parse(
      (await agent.get('/api/audit?pageSize=5&page=999').expect(200)).body,
    );
    expect(last.page).toBe(all.totalPages);
    // поиск по логину и по ключу действия
    const byLogin = auditListResponseSchema.parse(
      (await agent.get(`/api/audit?q=${LOGIN}`).expect(200)).body,
    );
    expect(byLogin.total).toBeGreaterThan(0);
    expect(byLogin.items.every((e) => e.actorDisplay === LOGIN || e.metadata.login === LOGIN)).toBe(true);
    const bySource = auditListResponseSchema.parse(
      (await agent.get('/api/audit?source=auto').expect(200)).body,
    );
    expect(bySource.items.every((e) => e.source === 'auto')).toBe(true);
    const failed = auditListResponseSchema.parse(
      (await agent.get('/api/audit?result=failed,denied').expect(200)).body,
    );
    expect(failed.items.every((e) => e.result !== 'ok')).toBe(true);
    await agent.get('/api/audit?category=nope').expect(400);
    await agent.get('/api/audit?pageSize=1000').expect(400);
  });

  it('append-only: UPDATE, DELETE и TRUNCATE отклоняет сама БД', async () => {
    const pool = app.get<Pool>(PG_POOL);
    await expect(pool.query(`update audit_log set result = 'ok'`)).rejects.toThrow(/append-only/);
    await expect(pool.query('delete from audit_log')).rejects.toThrow(/append-only/);
    await expect(pool.query('truncate audit_log')).rejects.toThrow(/append-only/);
  });

  it('партиции: ensureFor идемпотентен, retention удаляет старые разделы и пишет системное событие', async () => {
    const partitions = app.get(AuditPartitionsService);
    const old = new Date(Date.UTC(2020, 0, 15));
    expect(await partitions.ensureFor(old)).toBe('audit_log_y2020m01');
    expect(await partitions.ensureFor(old)).toBeNull();
    // запись в старый месяц ложится в свой раздел
    const svc = app.get(AuditService);
    const entry = await svc.record({
      action: 'system.started',
      actor: { type: 'system', display: 'test' },
      occurredAt: old,
    });
    expect(entry?.occurredAt).toBe(old.toISOString());
    const dropped = await partitions.applyRetention();
    expect(dropped).toContain('audit_log_y2020m01');
    expect((await partitions.listPartitions()).map((p) => p.name)).not.toContain('audit_log_y2020m01');
    const sys = auditListResponseSchema.parse(
      (await agent.get('/api/audit?category=system').expect(200)).body,
    );
    expect(
      sys.items.some(
        (e) => e.action === 'system.audit.partition_dropped' && e.targetId === 'audit_log_y2020m01',
      ),
    ).toBe(true);
    expect(sys.items.some((e) => e.action === 'system.audit.partition_created')).toBe(true);
  });

  it('запись в месяц без раздела создаёт раздел на лету', async () => {
    const future = new Date(Date.UTC(2031, 5, 1));
    const svc = app.get(AuditService);
    const entry = await svc.record({
      action: 'system.started',
      actor: { type: 'system', display: 'test' },
      occurredAt: future,
    });
    expect(entry).not.toBeNull();
    expect((await app.get(AuditPartitionsService).listPartitions()).map((p) => p.name)).toContain(
      'audit_log_y2031m06',
    );
    await db.execute(sql.raw('DROP TABLE "audit_log_y2031m06"'));
  });

  it('невалидная запись не роняет вызывающего: уходит в очередь повторов', async () => {
    const svc = app.get(AuditService);
    const before = svc.pending;
    const entry = await svc.record({
      action: 'x.y',
      category: 'bogus' as never,
      actor: { type: 'system', display: 't' },
    });
    expect(entry).toBeNull();
    expect(svc.pending).toBe(before + 1);
    expect(await svc.flush()).toBe(0);
  });

  it('SSE: событие на новую запись и догон по seq', async () => {
    const events = app.get(AuditEvents);
    const received: AuditEntry[] = [];
    const off = events.onCreated((e) => received.push(e));
    const entry = await app
      .get(AuditService)
      .record({ action: 'auth.logout', actor: { type: 'admin', id: 'u', display: LOGIN } });
    off();
    expect(received.map((e) => e.id)).toContain(entry?.id);
    const replay = await app.get(AuditRepository).since((entry?.seq ?? 1) - 1);
    expect(replay[0]?.id).toBe(entry?.id);
    // HTTP-поток SSE проверяется в scripts/screenshots.mjs (live-режим в браузере): supertest не умеет
    // аккуратно закрывать бесконечный ответ, а обрыв сокета всплывает как ECONNRESET.
  });

  it('экспорт CSV с BOM и заголовком; JSON — массив записей; без сессии — 401', async () => {
    const csv = await agent.get('/api/audit/export?format=csv&category=auth').expect(200);
    expect(csv.headers['content-type']).toContain('text/csv');
    expect(csv.headers['content-disposition']).toMatch(/attachment; filename="journal-.*\.csv"/);
    const text = csv.text;
    expect(text.charCodeAt(0)).toBe(0xfeff);
    expect(text.split('\r\n')[0]).toContain('Время,Категория,Действие');
    expect(text).toContain('Первый запуск: администратор создан');

    const json = await agent.get('/api/audit/export?format=json&category=auth').expect(200);
    const arr = JSON.parse(json.text) as AuditEntry[];
    expect(Array.isArray(arr)).toBe(true);
    expect(arr.some((e) => e.action === 'auth.setup.completed')).toBe(true);

    await request(app.getHttpServer()).get('/api/audit/export').expect(401);
  });
});

async function listPartitionNames(db: Db): Promise<string[]> {
  const res = await db.execute<{ name: string }>(
    sql`select c.relname as name from pg_inherits i join pg_class c on c.oid = i.inhrelid
        where i.inhparent = to_regclass('audit_log')`,
  );
  return res.rows.map((r) => r.name);
}
