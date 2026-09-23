import type { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import {
  auditListResponseSchema,
  CSRF_HEADER,
  incidentActionsResponseSchema,
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
import { IncidentMetricsService } from '../src/modules/incidents/incident-metrics.service.js';
import { IncidentRunnerService } from '../src/modules/incidents/incident-runner.service.js';
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

  /** Ждём, пока попытка по инциденту завершится (исполнитель работает в фоне). */
  const settled = async (id: string) => {
    await app.get(IncidentRunnerService).settle();
    return incidentSchema.parse((await agent.get(`/api/incidents/${id}`).expect(200)).body);
  };

  it('действие T1 вручную: пред-проверка → SSH → пост-проверка помогла → инцидент закрыт', async () => {
    const db = app.get<Db>(DB);
    await db.execute(sql`update servers set agent_status = 'online' where id = ${serverId}`);
    const repo = app.get(IncidentsRepository);
    const opened = await repo.open({
      serverId,
      serverName: 'inc-host',
      kind: 'disk_high',
      severity: 'warn',
      title: 'Диск заполняется · inc-host',
      detail: 'Диск держится выше порога.',
      timeline: [{ at: new Date().toISOString(), by: 'auto', action: 'Обнаружено', result: 'detect' }],
    });
    const id = opened?.id ?? '';
    // метрики: диск 94 % до действия, после — 60 % (пост-проверка увидит «ниже порога − 5»)
    const metrics = app.get(IncidentMetricsService);
    metrics.setForTest(serverId, { disk: 94 });
    const before = ssh.execLog.length;
    // T3 панель не выполняет
    await agent.post(`/api/incidents/${id}/actions/disk_inspect/run`).set(CSRF_HEADER, csrf).expect(400);
    const started = incidentSchema.parse(
      (await agent.post(`/api/incidents/${id}/actions/free_disk/run`).set(CSRF_HEADER, csrf).expect(202))
        .body,
    );
    expect(started.attempts[0]?.status).toBe('running');
    expect(started.status).toBe('acknowledged');
    // повторный запуск, пока идёт — 409
    await agent.post(`/api/incidents/${id}/actions/free_disk/run`).set(CSRF_HEADER, csrf).expect(409);
    metrics.setForTest(serverId, { disk: 60 });
    const done = await settled(id);
    const attempt = done.attempts[0];
    expect(attempt?.status).toBe('helped');
    expect(attempt?.steps.map((st) => `${st.key}:${st.status}`)).toEqual([
      'precheck:ok',
      'action:ok',
      'postcheck:ok',
      'rollback:skipped',
    ]);
    expect(attempt?.log).toContain('journalctl');
    expect(done.status).toBe('resolved');
    expect(done.resolvedBy).toBe('manual');
    expect(done.timeline.some((e) => e.result === 'helped' && e.level === 'T1')).toBe(true);
    expect(ssh.execLog.length).toBeGreaterThan(before);
    expect(ssh.execLog.some((c) => c.includes('journalctl'))).toBe(true);
    // закрытый инцидент — действие не запустить
    await agent.post(`/api/incidents/${id}/actions/free_disk/run`).set(CSRF_HEADER, csrf).expect(409);

    const audit = auditListResponseSchema.parse(
      (await agent.get('/api/audit?category=server').expect(200)).body,
    );
    expect(audit.items.some((e) => e.action === 'incident.autofix')).toBe(true);
    expect(audit.items.some((e) => e.action === 'incident.opened')).toBe(true);
  });

  it('не помогло → следующий шаг T3 (только вручную); «Да» на T2 помогает; пред-проверка не пройдена → понижение до T2', async () => {
    const db = app.get<Db>(DB);
    await db.execute(sql`update servers set agent_status = 'online' where id = ${serverId}`);
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
    const metrics = app.get(IncidentMetricsService);
    metrics.setForTest(serverId, { cpu: 97 });
    // неподходящее действие — 400
    await agent.post(`/api/incidents/${id}/actions/free_disk/run`).set(CSRF_HEADER, csrf).expect(400);
    await agent.post(`/api/incidents/${id}/actions/restart_node/run`).set(CSRF_HEADER, csrf).expect(202);
    const after1 = await settled(id);
    expect(after1.attempts[0]?.status).toBe('not_helped');
    expect(after1.status).not.toBe('resolved');
    // дальше по цепочке только перезагрузка — T3, панель не выполняет
    expect(after1.proposal).toMatchObject({ action: 'reboot', level: 'T3' });
    expect(after1.timeline.some((e) => e.result === 'escalate' && e.level === 'T3')).toBe(true);
    await agent.post(`/api/incidents/${id}/resolve`).set(CSRF_HEADER, csrf).expect(200);
    const opened1b = await repo.open({
      serverId,
      serverName: 'inc-host',
      kind: 'cpu_high',
      severity: 'warn',
      title: 'Высокая нагрузка на CPU · inc-host',
      detail: 'снова выше порога',
      timeline: [{ at: new Date().toISOString(), by: 'auto', action: 'Обнаружено', result: 'detect' }],
    });
    const id1b = opened1b?.id ?? '';

    // «Да» на предложение: перезапуск контейнера помогает (CPU падает)
    const p = agent.post(`/api/incidents/${id1b}/actions/restart_node/run`).set(CSRF_HEADER, csrf);
    metrics.setForTest(serverId, { cpu: 40 });
    await p.expect(202);
    const after2 = await settled(id1b);
    expect(after2.proposal).toBeNull();
    expect(after2.attempts[0]?.status).toBe('helped');
    expect(after2.status).toBe('resolved');

    // пред-проверка не пройдена (агент офлайн) в авто → понижение до T2 и предложение
    await db.execute(sql`update servers set agent_status = 'offline' where id = ${serverId}`);
    const opened2 = await repo.open({
      serverId,
      serverName: 'inc-host',
      kind: 'cpu_high',
      severity: 'warn',
      title: 'Высокая нагрузка на CPU · inc-host',
      detail: 'снова',
      timeline: [{ at: new Date().toISOString(), by: 'auto', action: 'Обнаружено', result: 'detect' }],
    });
    const id2 = opened2?.id ?? '';
    await app.get(IncidentRunnerService).start(id2, 'restart_node', 'auto');
    const after3 = await settled(id2);
    expect(after3.attempts[0]?.status).toBe('precheck_failed');
    expect(after3.attempts[0]?.steps[0]?.note).toContain('агент не в сети');
    expect(after3.proposal).toMatchObject({ action: 'restart_node', level: 'T2' });
    await agent.post(`/api/incidents/${id2}/resolve`).set(CSRF_HEADER, csrf).expect(200);
    await db.execute(sql`update servers set agent_status = 'online' where id = ${serverId}`);
  });

  it('вкладка «Автопочинка»: реестр со статистикой, тумблеры пишутся в настройки; автотик предлагает шаг', async () => {
    const list = incidentActionsResponseSchema.parse(
      (await agent.get('/api/incidents/actions').expect(200)).body,
    );
    expect(list.autofixEnabled).toBe(false);
    const free = list.items.find((a) => a.key === 'free_disk');
    expect(free?.level).toBe('T1');
    expect(free?.enabled).toBe(false);
    expect(free?.stats.runs).toBeGreaterThanOrEqual(1);
    expect(free?.stats.helped).toBeGreaterThanOrEqual(1);
    expect(list.items.find((a) => a.key === 'reboot')?.terminal).toBe(true);

    const upd = incidentActionsResponseSchema.parse(
      (
        await agent
          .patch('/api/incidents/actions')
          .set(CSRF_HEADER, csrf)
          .send({ autofixEnabled: true, actions: { free_disk: true, restart_node: true } })
          .expect(200)
      ).body,
    );
    expect(upd.autofixEnabled).toBe(true);
    expect(upd.items.find((a) => a.key === 'free_disk')?.enabled).toBe(true);
    // T2 нельзя включить в авто
    expect(upd.items.find((a) => a.key === 'restart_node')?.enabled).toBe(false);

    // автотик: свежий инцидент памяти (первый шаг T2) → предложение, без выполнения
    const repo = app.get(IncidentsRepository);
    const opened = await repo.open({
      serverId,
      serverName: 'inc-host',
      kind: 'mem_high',
      severity: 'warn',
      title: 'Память на пределе · inc-host',
      detail: 'память выше порога',
      timeline: [{ at: new Date().toISOString(), by: 'auto', action: 'Обнаружено', result: 'detect' }],
    });
    await app.get(IncidentRunnerService).autoTick();
    const inc = await settled(opened?.id ?? '');
    expect(inc.attempts).toHaveLength(0);
    expect(inc.proposal).toMatchObject({ action: 'restart_node', level: 'T2' });
    await agent.post(`/api/incidents/${opened?.id}/resolve`).set(CSRF_HEADER, csrf).expect(200);

    // автотик: свежий инцидент диска с включённым T1 → выполняется само и закрывается
    app.get(IncidentMetricsService).setForTest(serverId, { disk: 96 });
    const opened2 = await repo.open({
      serverId,
      serverName: 'inc-host',
      kind: 'disk_high',
      severity: 'warn',
      title: 'Диск заполняется · inc-host',
      detail: 'диск выше порога',
      timeline: [{ at: new Date().toISOString(), by: 'auto', action: 'Обнаружено', result: 'detect' }],
    });
    const tick = app.get(IncidentRunnerService).autoTick();
    app.get(IncidentMetricsService).setForTest(serverId, { disk: 50 });
    await tick;
    const inc2 = await settled(opened2?.id ?? '');
    expect(inc2.attempts[0]).toMatchObject({ by: 'auto', status: 'helped' });
    expect(inc2.status).toBe('resolved');
    expect(inc2.resolvedBy).toBe('auto');
    await agent
      .patch('/api/incidents/actions')
      .set(CSRF_HEADER, csrf)
      .send({ autofixEnabled: false })
      .expect(200);
  });

  it('xray_down: процесс пропал → инцидент; «Перезапустить Xray» помог — процесс вернулся', async () => {
    const db = app.get<Db>(DB);
    await db.execute(sql`update servers set agent_status = 'online' where id = ${serverId}`);
    const svc = app.get(IncidentsService);
    await svc.evaluate({ ...noMetrics, xray: new Map([[serverId, 0]]) });
    const list = incidentsListResponseSchema.parse(
      (await agent.get('/api/incidents?status=open').expect(200)).body,
    );
    const inc = list.items.find((i) => i.kind === 'xray_down');
    expect(inc?.severity).toBe('crit');
    // авто выключено → предложение первого шага цепочки (T1 node_up)
    expect(inc?.proposal).toMatchObject({ action: 'node_up', level: 'T1' });
    const metrics = app.get(IncidentMetricsService);
    const p = agent.post(`/api/incidents/${inc?.id}/actions/node_up/run`).set(CSRF_HEADER, csrf);
    metrics.setForTest(serverId, { xray: 1 });
    await p.expect(202);
    const done = await settled(inc?.id ?? '');
    expect(done.attempts[0]?.status).toBe('helped');
    expect(done.attempts[0]?.steps[2]?.note).toContain('xray запущен');
    expect(done.status).toBe('resolved');
    // старый агент без метрики — не судим: инцидент не заводится
    await svc.evaluate(noMetrics);
    const after = incidentsListResponseSchema.parse(
      (await agent.get('/api/incidents?status=open').expect(200)).body,
    );
    expect(after.items.some((i) => i.kind === 'xray_down')).toBe(false);
  });

  it('ручное закрытие инцидента', async () => {
    await app.get(IncidentsRepository).open({
      serverId,
      serverName: 'inc-host',
      kind: 'cpu_high',
      severity: 'warn',
      title: 'Высокая нагрузка на CPU · inc-host',
      detail: 'для ручного закрытия',
      timeline: [{ at: new Date().toISOString(), by: 'auto', action: 'Обнаружено', result: 'detect' }],
    });
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
