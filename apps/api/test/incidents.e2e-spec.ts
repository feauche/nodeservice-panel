import type { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import {
  auditListResponseSchema,
  CSRF_HEADER,
  incidentPolicyResponseSchema,
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
    // действие не из этого вида инцидента — 400
    await agent.post(`/api/incidents/${id}/actions/node_up/run`).set(CSRF_HEADER, csrf).expect(400);
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

  it('осмотр T0 «Найти, что занимает диск» выполняется сам, когда чистка не помогла', async () => {
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
    // диск не падает: чистка не поможет
    app.get(IncidentMetricsService).setForTest(serverId, { disk: 94 });
    await agent.post(`/api/incidents/${id}/actions/apt_clean/run`).set(CSRF_HEADER, csrf).expect(202);
    const done = await settled(id);
    expect(done.attempts[0]).toMatchObject({ action: 'apt_clean', status: 'not_helped' });
    // следующий шаг — осмотр: панель выполнила его сама, ничего не спрашивая
    expect(done.attempts[1]).toMatchObject({ action: 'disk_inspect', level: 'T0', status: 'done' });
    expect(done.attempts[1]?.log).toContain('du -xh');
    expect(done.status).not.toBe('resolved');
    expect(done.timeline.some((e) => e.action.includes('список получен'))).toBe(true);
    // цепочка кончилась — дальше руками
    expect(done.timeline.some((e) => e.result === 'escalate' && e.action.includes('исчерпаны'))).toBe(true);
    await agent.post(`/api/incidents/${id}/resolve`).set(CSRF_HEADER, csrf).expect(200);
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

    // подтверждение предложения: перезапуск контейнера помогает (CPU падает)
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

  it('автопочинка: политика по сигналам со статистикой; «Само» выполняет T1, «Спросить» предлагает, «Наблюдать» молчит', async () => {
    const list = incidentPolicyResponseSchema.parse(
      (await agent.get('/api/incidents/policy').expect(200)).body,
    );
    expect(list.autofixEnabled).toBe(false);
    expect(list.pausedUntil).toBeNull();
    const disk = list.items.find((a) => a.kind === 'disk_high');
    expect(disk?.policy).toBe('ask');
    expect(disk?.autoAvailable).toBe(true);
    expect(disk?.chain[0]).toMatchObject({ key: 'free_disk', level: 'T1' });
    expect(disk?.stats.runs).toBeGreaterThanOrEqual(1);
    expect(disk?.stats.helped).toBeGreaterThanOrEqual(1);
    expect(list.items.find((a) => a.kind === 'ssh_down')?.autoAvailable).toBe(false);

    const upd = incidentPolicyResponseSchema.parse(
      (
        await agent
          .patch('/api/incidents/policy')
          .set(CSRF_HEADER, csrf)
          .send({ autofixEnabled: true, policy: { disk_high: 'auto', mem_high: 'ask', cpu_high: 'watch' } })
          .expect(200)
      ).body,
    );
    expect(upd.autofixEnabled).toBe(true);
    expect(upd.items.find((a) => a.kind === 'disk_high')?.policy).toBe('auto');
    expect(upd.items.find((a) => a.kind === 'cpu_high')?.policy).toBe('watch');

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
    // «Наблюдать»: инцидент CPU без предложения и без попыток
    const opened3 = await repo.open({
      serverId,
      serverName: 'inc-host',
      kind: 'cpu_high',
      severity: 'warn',
      title: 'Высокая нагрузка на CPU · inc-host',
      detail: 'cpu выше порога',
      timeline: [{ at: new Date().toISOString(), by: 'auto', action: 'Обнаружено', result: 'detect' }],
    });
    await app.get(IncidentRunnerService).autoTick();
    const inc3 = await settled(opened3?.id ?? '');
    expect(inc3.attempts).toHaveLength(0);
    expect(inc3.proposal).toBeNull();
    await agent.post(`/api/incidents/${opened3?.id}/resolve`).set(CSRF_HEADER, csrf).expect(200);

    // пауза: с «Само» ничего не выполняется, пока пауза не снята
    const paused = incidentPolicyResponseSchema.parse(
      (
        await agent
          .patch('/api/incidents/policy')
          .set(CSRF_HEADER, csrf)
          .send({ pauseMinutes: 60 })
          .expect(200)
      ).body,
    );
    expect(paused.pausedUntil).not.toBeNull();
    await agent.patch('/api/incidents/policy').set(CSRF_HEADER, csrf).send({ pauseMinutes: 0 }).expect(200);

    await agent
      .patch('/api/incidents/policy')
      .set(CSRF_HEADER, csrf)
      .send({ autofixEnabled: false, policy: { cpu_high: 'ask', disk_high: 'ask' } })
      .expect(200);
  });

  it('node_down: контейнер остановлен → инцидент; «Поднять контейнер» помог', async () => {
    const db = app.get<Db>(DB);
    await db.execute(sql`update servers set agent_status = 'online' where id = ${serverId}`);
    const svc = app.get(IncidentsService);
    // контейнера нет (зонд: none) — не судим
    await svc.probeNodeState(serverId, null);
    await svc.evaluate(noMetrics);
    expect(
      incidentsListResponseSchema
        .parse((await agent.get('/api/incidents?status=open').expect(200)).body)
        .items.some((i) => i.kind === 'node_down'),
    ).toBe(false);
    // зонд увидел остановленный контейнер → инцидент в тот же момент, без тика
    await svc.probeNodeState(serverId, 'stopped');
    expect(
      incidentsListResponseSchema
        .parse((await agent.get('/api/incidents?status=open').expect(200)).body)
        .items.some((i) => i.kind === 'node_down'),
    ).toBe(true);
    // предложение первого шага — на тике автопочинки
    await svc.evaluate(noMetrics);
    const list = incidentsListResponseSchema.parse(
      (await agent.get('/api/incidents?status=open').expect(200)).body,
    );
    const inc0 = list.items.find((i) => i.kind === 'node_down');
    expect(inc0?.severity).toBe('crit');
    expect(inc0?.proposal).toMatchObject({ action: 'node_up', level: 'T1' });
    // контейнер вернулся сам → инцидент закрывается зондом сразу; упал снова → новый инцидент
    await svc.probeNodeState(serverId, 'running');
    expect(
      incidentSchema.parse((await agent.get(`/api/incidents/${inc0?.id}`).expect(200)).body).status,
    ).toBe('resolved');
    await svc.probeNodeState(serverId, 'stopped');
    await svc.evaluate(noMetrics);
    const inc2 = incidentsListResponseSchema
      .parse((await agent.get('/api/incidents?status=open').expect(200)).body)
      .items.find((i) => i.kind === 'node_down');
    expect(inc2?.id).not.toBe(inc0?.id);
    const inc = inc2;

    // «Да» на «Поднять контейнер ноды»: зонд видит контейнер запущенным → помогло
    const p = agent.post(`/api/incidents/${inc?.id}/actions/node_up/run`).set(CSRF_HEADER, csrf);
    svc.recordNodeState(serverId, 'running');
    await p.expect(202);
    const done = await settled(inc?.id ?? '');
    expect(done.attempts[0]?.status).toBe('helped');
    expect(done.attempts[0]?.steps[2]?.note).toContain('контейнер ноды запущен');
    expect(done.status).toBe('resolved');
    expect(ssh.execLog.some((c) => c.includes('docker start'))).toBe(true);
  });

  it('нода на сервере: «Нет, не следить» — остановленный контейнер не инцидент; «Есть» — «не найден» инцидент; галочка при закрытии выключает слежение', async () => {
    const svc = app.get(IncidentsService);
    const openNode = async () =>
      incidentsListResponseSchema
        .parse((await agent.get('/api/incidents?status=open').expect(200)).body)
        .items.find((i) => i.kind === 'node_down');
    await agent
      .patch(`/api/servers/${serverId}`)
      .set(CSRF_HEADER, csrf)
      .send({ nodeWatch: 'off' })
      .expect(200);
    await svc.probeNodeState(serverId, 'stopped');
    expect(await openNode()).toBeUndefined();

    await agent
      .patch(`/api/servers/${serverId}`)
      .set(CSRF_HEADER, csrf)
      .send({ nodeWatch: 'on' })
      .expect(200);
    await svc.probeNodeState(serverId, 'none');
    const inc = await openNode();
    expect(inc?.detail).toContain('не найден');
    const srv = serverSchema.parse((await agent.get(`/api/servers/${serverId}`).expect(200)).body);
    expect(srv.node).toBe('none');

    const resolved = incidentSchema.parse(
      (
        await agent
          .post(`/api/incidents/${inc?.id}/resolve`)
          .set(CSRF_HEADER, csrf)
          .send({ stopNodeWatch: true })
          .expect(200)
      ).body,
    );
    expect(resolved.timeline.some((e) => e.action.includes('Слежение за нодой'))).toBe(true);
    const srv2 = serverSchema.parse((await agent.get(`/api/servers/${serverId}`).expect(200)).body);
    expect(srv2.nodeWatch).toBe('off');
    expect(srv2.node).toBeNull();
    // слежение выключено — тот же сбой инцидент больше не заводит
    await svc.probeNodeState(serverId, 'stopped');
    expect(await openNode()).toBeUndefined();
    await agent
      .patch(`/api/servers/${serverId}`)
      .set(CSRF_HEADER, csrf)
      .send({ nodeWatch: 'auto' })
      .expect(200);
    await svc.probeNodeState(serverId, 'running');
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

  /** Попытка «выполняется», которую некому завершить — как после перезапуска панели. */
  const orphanAttempt = (ageMs: number) => ({
    id: crypto.randomUUID(),
    action: 'node_up',
    level: 'T1' as const,
    by: 'manual' as const,
    status: 'running' as const,
    startedAt: new Date(Date.now() - ageMs).toISOString(),
    finishedAt: null,
    steps: [
      {
        key: 'precheck' as const,
        label: 'Пред-проверка',
        status: 'ok' as const,
        startedAt: null,
        finishedAt: null,
        note: 'SSH отвечает',
      },
      {
        key: 'action' as const,
        label: 'Поднять контейнер ноды',
        status: 'running' as const,
        startedAt: null,
        finishedAt: null,
        note: null,
      },
      {
        key: 'postcheck' as const,
        label: 'Пост-проверка',
        status: 'pending' as const,
        startedAt: null,
        finishedAt: null,
        note: null,
      },
      {
        key: 'rollback' as const,
        label: 'Откат',
        status: 'pending' as const,
        startedAt: null,
        finishedAt: null,
        note: null,
      },
    ],
    log: '$ docker start',
  });
  const openWithOrphan = async (ageMs: number) => {
    const repo = app.get(IncidentsRepository);
    const row = await repo.open({
      serverId,
      serverName: 'inc-host',
      kind: 'node_down',
      severity: 'crit',
      title: 'Контейнер ноды не запущен · inc-host',
      detail: 'осиротевшая попытка',
      timeline: [{ at: new Date().toISOString(), by: 'auto', action: 'Обнаружено', result: 'detect' }],
    });
    await repo.update(row?.id ?? '', { attempts: [orphanAttempt(ageMs)] });
    return row?.id ?? '';
  };

  it('ручное закрытие обрывает идущую попытку — она не висит «выполняется»', async () => {
    const id = await openWithOrphan(0);
    const resolved = incidentSchema.parse(
      (await agent.post(`/api/incidents/${id}/resolve`).set(CSRF_HEADER, csrf).expect(200)).body,
    );
    expect(resolved.status).toBe('resolved');
    expect(resolved.attempts[0]).toMatchObject({ status: 'failed' });
    expect(resolved.attempts[0]?.finishedAt).not.toBeNull();
    expect(resolved.attempts[0]?.steps[1]).toMatchObject({
      status: 'failed',
      note: expect.stringContaining('закрыт администратором'),
    });
    expect(resolved.attempts[0]?.steps[2]?.status).toBe('skipped');
    expect(resolved.timeline.some((e) => e.action.includes('Поднять контейнер ноды: прервано'))).toBe(true);
  });

  it('после перезапуска панели осиротевшие попытки закрываются, новое действие снова можно запустить', async () => {
    const id = await openWithOrphan(0);
    await agent.post(`/api/incidents/${id}/actions/node_up/run`).set(CSRF_HEADER, csrf).expect(409);
    await app.get(IncidentRunnerService).onModuleInit();
    const after = incidentSchema.parse((await agent.get(`/api/incidents/${id}`).expect(200)).body);
    expect(after.attempts[0]).toMatchObject({ status: 'failed' });
    expect(after.attempts[0]?.steps[1]?.note).toContain('перезапуском панели');
    expect(after.status).not.toBe('resolved');
    await agent.post(`/api/incidents/${id}/actions/node_up/run`).set(CSRF_HEADER, csrf).expect(202);
    await settled(id);
    await agent.post(`/api/incidents/${id}/resolve`).set(CSRF_HEADER, csrf);
  });

  it('сторож: попытка «выполняется» дольше лимита и не в памяти — закрывается на тике', async () => {
    const id = await openWithOrphan(5_000);
    await app.get(IncidentsService).evaluate(noMetrics);
    const after = incidentSchema.parse((await agent.get(`/api/incidents/${id}`).expect(200)).body);
    expect(after.attempts[0]).toMatchObject({ status: 'failed' });
    expect(after.attempts[0]?.steps[1]?.note).toContain('зависло');
    await agent.post(`/api/incidents/${id}/resolve`).set(CSRF_HEADER, csrf);
  });

  it('удаление: открытый с идущей попыткой — попытка обрывается и запись исчезает; DELETE resolved чистит историю', async () => {
    const id = await openWithOrphan(0);
    await agent.delete(`/api/incidents/${id}`).set(CSRF_HEADER, csrf).expect(204);
    await agent.get(`/api/incidents/${id}`).expect(404);
    const audit = auditListResponseSchema.parse(
      (await agent.get('/api/audit?category=server').expect(200)).body,
    );
    expect(audit.items.some((e) => e.action === 'incident.deleted')).toBe(true);

    const before = incidentsListResponseSchema.parse(
      (await agent.get('/api/incidents?status=resolved').expect(200)).body,
    );
    expect(before.items.length).toBeGreaterThan(0);
    const res = await agent.delete('/api/incidents/resolved').set(CSRF_HEADER, csrf).expect(200);
    expect(res.body.deleted).toBe(before.items.length);
    const after = incidentsListResponseSchema.parse(
      (await agent.get('/api/incidents?status=resolved').expect(200)).body,
    );
    expect(after.items).toHaveLength(0);
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
