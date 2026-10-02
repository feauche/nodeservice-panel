import type { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import {
  auditListResponseSchema,
  CSRF_HEADER,
  incidentPolicyResponseSchema,
  incidentSchema,
  incidentsListResponseSchema,
  incidentWeekStatsSchema,
  notificationsResponseSchema,
  serverSchema,
} from '@nodeservice/shared';
import { sql } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import { generate } from 'otplib';
import request from 'supertest';
import TestAgent from 'supertest/lib/agent.js';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { AppModule } from '../src/app.module.js';
import { setupHttp } from '../src/common/http/setup-http.js';
import { DB, type Db } from '../src/infra/db/db.module.js';
import { runMigrations } from '../src/infra/db/migrate.js';
import { VALKEY } from '../src/infra/valkey/valkey.module.js';
import { SetupService } from '../src/modules/auth/setup.service.js';
import { AgentPendingJob } from '../src/modules/incidents/agent-pending.job.js';
import { egressVerdict } from '../src/modules/incidents/egress-check.logic.js';
import { EgressCheckService } from '../src/modules/incidents/egress-check.service.js';
import { IncidentMetricsService } from '../src/modules/incidents/incident-metrics.service.js';
import { IncidentRunnerService } from '../src/modules/incidents/incident-runner.service.js';
import { IncidentsRepository } from '../src/modules/incidents/incidents.repository.js';
import { IncidentsService, PARTIAL_MARK } from '../src/modules/incidents/incidents.service.js';
import { NodeBlockCheckService } from '../src/modules/incidents/node-block-check.service.js';
import { NotificationsService } from '../src/modules/notifications/notifications.service.js';
import { ServersService } from '../src/modules/servers/servers.service.js';
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
      sql`truncate users, recovery_codes, trusted_devices, setup_tokens, servers, incidents, billing_items, notifications cascade`,
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
    const pushed = vi.spyOn(app.get(NotificationsService), 'push');
    await db.execute(sql`update servers set agent_status = 'online' where id = ${serverId}`);
    await svc.evaluate(noMetrics);
    const after = incidentsListResponseSchema.parse(
      (await agent.get('/api/incidents?status=open').expect(200)).body,
    );
    expect(after.items.some((i) => i.kind === 'agent_offline')).toBe(false);
    // В Telegram закрытие уходит с пометкой «проблема исчезла сама»: если тревога о деле ещё ждала разбора,
    // вместо пары «тревога → починилось» придёт одно сообщение о коротком сбое.
    expect(pushed.mock.calls.map(([n]) => n.telegram).find((t) => t?.event === 'resolved')?.closed).toEqual({
      recovered: true,
    });
    pushed.mockRestore();
    const resolved = incidentsListResponseSchema.parse(
      (await agent.get('/api/incidents?status=resolved').expect(200)).body,
    );
    expect(resolved.items.some((i) => i.kind === 'agent_offline' && i.resolvedBy === 'auto')).toBe(true);

    // Полоса «за 7 дней»: готовые цифры с сервера, закрытый сам собой инцидент — в «ушло само».
    const week = incidentWeekStatsSchema.parse(
      (await agent.get('/api/incidents/week-stats').expect(200)).body,
    );
    expect(week.total).toBeGreaterThanOrEqual(1);
    expect(week.self).toBeGreaterThanOrEqual(1);
  });

  it('агент офлайн и SSH тоже недоступен → одно дело «Сервер недоступен», переустановку агента не предлагаем', async () => {
    const db = app.get<Db>(DB);
    const svc = app.get(IncidentsService);
    const bc = app.get(NodeBlockCheckService);
    const probe = svc.probeHost;
    const reach = bc.countryReach;
    svc.probeHost = async () => false;
    bc.countryReach = async () => ({
      results: [{ from: 'Германия-1', country: 'DE', open: false }],
      blind: null,
    });
    (svc as unknown as { hostCache: Map<string, unknown> }).hostCache.clear();
    (svc as unknown as { reachCache: Map<string, unknown> }).reachCache.clear();
    await db.execute(sql`update servers set agent_status = 'offline', ssh_ok = false where id = ${serverId}`);
    await svc.evaluate(noMetrics);
    await svc.evaluate(noMetrics);

    const list = incidentsListResponseSchema.parse(
      (await agent.get('/api/incidents?status=open').expect(200)).body,
    );
    const mine = list.items.filter((i) => i.serverName === 'inc-host');
    expect(mine.map((i) => i.kind)).toEqual(['server_down']);
    expect(mine[0]?.proposal).toBeNull();
    expect(mine[0]?.detail).toMatch(/переустанавливать агента бессмысленно/);

    // SSH снова работает, агент молчит — сервер отвечает: дело закрыто, открыто «Агент не в сети» с шагом
    svc.probeHost = probe;
    bc.countryReach = reach;
    (svc as unknown as { hostCache: Map<string, unknown> }).hostCache.clear();
    (svc as unknown as { reachCache: Map<string, unknown> }).reachCache.clear();
    await db.execute(sql`update servers set ssh_ok = true where id = ${serverId}`);
    await svc.evaluate(noMetrics);
    const after = incidentsListResponseSchema.parse(
      (await agent.get('/api/incidents?status=open').expect(200)).body,
    );
    expect(after.items.some((i) => i.kind === 'server_down')).toBe(false);
    const inc2 = after.items.find((i) => i.kind === 'agent_offline');
    expect(inc2?.proposal).toMatchObject({ action: 'agent_reinstall', level: 'T2' });

    await db.execute(sql`update servers set agent_status = 'online' where id = ${serverId}`);
    await svc.evaluate(noMetrics);
  });

  it('сначала проверяем сервер: порт SSH не открывается → «Сервер недоступен»; открытое «Агент не в сети» уточняется, «Похоже на блокировку» присоединяется', async () => {
    const db = app.get<Db>(DB);
    const svc = app.get(IncidentsService);
    const repo = app.get(IncidentsRepository);
    const bc = app.get(NodeBlockCheckService);
    const probe = svc.probeHost;
    const reach = bc.countryReach;
    try {
      // Агент замолчал, сервер отвечает — «Агент не в сети» с предложением переустановить.
      await db.execute(
        sql`update servers set agent_status = 'offline', ssh_ok = true where id = ${serverId}`,
      );
      await svc.evaluate(noMetrics);
      const first = (await repo.findOpen(serverId, 'agent_offline')) as { id: string; proposal: unknown };
      expect(first.proposal).not.toBeNull();
      await repo.open({
        serverId,
        serverName: 'inc-host',
        kind: 'node_blocked',
        severity: 'warn',
        title: 'Похоже на блокировку · inc-host',
        detail: 'Онлайн упал.',
        timeline: [],
      });

      // Через минуту порт SSH перестал открываться: то же дело становится «Сервер недоступен».
      svc.probeHost = async () => false;
      bc.countryReach = async () => ({
        results: [{ from: 'Германия-1', country: 'DE', open: false }],
        blind: null,
      });
      (svc as unknown as { hostCache: Map<string, unknown> }).hostCache.clear();
      (svc as unknown as { reachCache: Map<string, unknown> }).reachCache.clear();
      const pushed = vi.spyOn(app.get(NotificationsService), 'push');
      const closings = () =>
        pushed.mock.calls.map(([n]) => n).filter((n) => n.telegram?.event === 'resolved');
      await svc.evaluate(noMetrics);
      await svc.evaluate(noMetrics);
      const open = incidentsListResponseSchema
        .parse((await agent.get('/api/incidents?status=open').expect(200)).body)
        .items.filter((i) => i.serverName === 'inc-host');
      expect(open.map((i) => i.kind)).toEqual(['server_down']);
      // «Похоже на блокировку» не решилось, а влилось в главное дело: его закрытие помечено как слияние —
      // тревога о нём, если ещё ждала разбора, снимается молча, без «короткий сбой уже прошёл».
      expect(closings().map((n) => [n.title, n.telegram?.closed])).toEqual([
        ['Похоже на блокировку · {server} — закрыт', 'merged'],
      ]);
      const refined = open[0];
      expect(refined?.id).toBe(first.id);
      expect(refined?.proposal).toBeNull();
      expect(refined?.detail).toMatch(/порт SSH 127\.0\.0\.1:\d+ не открывается/);
      const texts = refined?.timeline.map((e) => e.action).join('\n') ?? '';
      expect(texts).toMatch(
        /Уточнено: сервер недоступен целиком — порт SSH тоже не отвечает\. Предложение «Переустановить агента» снято/,
      );
      expect(texts).toMatch(/Присоединено: «Похоже на блокировку»/);

      // Агент вернулся — дело закрыто само.
      svc.probeHost = probe;
      await db.execute(sql`update servers set agent_status = 'online' where id = ${serverId}`);
      await svc.evaluate(noMetrics);
      expect(await repo.findOpen(serverId, 'server_down')).toBeUndefined();
      // Закрытие с причиной: «в норме» панель от себя не добавляет, причина уходит как есть.
      expect(closings().at(-1)?.telegram?.closed).toEqual({
        recovered: false,
        how: 'Сервер снова на связи: агент и SSH отвечают.',
      });
      pushed.mockRestore();
    } finally {
      svc.probeHost = probe;
      bc.countryReach = reach;
      (svc as unknown as { hostCache: Map<string, unknown> }).hostCache.clear();
      (svc as unknown as { reachCache: Map<string, unknown> }).reachCache.clear();
    }
  });

  it('окно оплаты: сервер недоступен, а срок оплаты через пару часов → «Сервер недоступен — проверьте оплату», в тексте и в уведомлении', async () => {
    const db = app.get<Db>(DB);
    const svc = app.get(IncidentsService);
    const repo = app.get(IncidentsRepository);
    const bc = app.get(NodeBlockCheckService);
    const probe = svc.probeHost;
    const reach = bc.countryReach;
    const open = async () =>
      incidentsListResponseSchema
        .parse((await agent.get('/api/incidents?status=open').expect(200)).body)
        .items.filter((i) => i.serverName === 'inc-host');
    // Срок в «Биллинге» ещё не прошёл, но до него меньше суток — окно оплаты. Сертификат рядом — не в счёт.
    await db.execute(
      sql`insert into billing_items (kind, title, server_ids, amount_minor, currency, period_unit, period_count, paid_until)
          values ('server', 'inc-host VPS', ${JSON.stringify([serverId])}::jsonb, 45100, 'RUB', 'month', 1, now() + interval '3 hours'),
                 ('cert', 'certwarden', ${JSON.stringify([serverId])}::jsonb, 90000, 'RUB', 'year', 1, now() - interval '1 day')`,
    );
    const hostCache = (svc as unknown as { hostCache: Map<string, unknown> }).hostCache;
    const back = async () => {
      await db.execute(sql`update servers set agent_status = 'online', ssh_ok = true where id = ${serverId}`);
      await svc.evaluate(noMetrics);
    };
    const lose = async () => {
      hostCache.clear();
      await db.execute(
        sql`update servers set agent_status = 'offline', ssh_ok = false where id = ${serverId}`,
      );
      await svc.evaluate(noMetrics);
      await svc.evaluate(noMetrics);
    };
    try {
      // Агент молчит и SSH не пускает, но порт SSH с панели открывается: сервер включён — хостер его не
      // отключал, и оплата тут ни при чём.
      await lose();
      const alive = await open();
      expect(alive.map((item) => item.kind).sort()).toEqual(['agent_offline', 'ssh_down']);
      for (const item of alive)
        for (const s of ['💳', 'оплат', 'выключен']) expect(item.detail, s).not.toContain(s);
      await back();

      // Порт SSH не открывается — сервер не отвечает совсем.
      svc.probeHost = async () => false;
      bc.countryReach = async () => ({
        results: [{ from: 'Германия-1', country: 'DE', open: false }],
        blind: null,
      });
      await lose();
      const [down] = await open();
      expect(down?.kind).toBe('server_down');
      expect(down?.title).toBe('Сервер недоступен — проверьте оплату · inc-host');
      // Срок — датой в поясе панели; относительного «через 3 часа» в хранимом тексте нет.
      expect(down?.detail).toMatch(
        /\n\n💳 Срок оплаты близко: Сервер «inc-host VPS»: 451 ₽, оплачено до \d{1,2} [а-я]+( \d{4})?, \d{2}:\d{2} \((МСК|UTC[+-]\d+)\)\.\n/,
      );
      // Независимая зарубежная точка тоже не видит порт, поэтому отключение подтверждено не только сетью
      // панели; близкая оплата может быть причиной, но вывод остаётся вероятностным.
      expect(down?.detail).toContain('Порт SSH');
      expect(down?.detail).toContain('Германия-1 — порт не отвечает');
      expect(down?.detail).toContain('Вероятнее всего: оплата закончилась чуть раньше срока');
      // Просроченный сертификат сервер не выключает — в дело не попал и заголовок не стал «просрочена оплата».
      expect(down?.detail).not.toContain('certwarden');
      // В колокольчике заголовок тот же, что у дела, а не просто «Сервер недоступен».
      const bell = (await agent.get('/api/notifications').expect(200)).body as {
        items: Array<{ title: string }>;
      };
      expect(bell.items.map((n) => n.title)).toContain('Сервер недоступен — проверьте оплату · inc-host');

      // Сервер вернулся — дело закрыто; закрытие (оно уходит в Telegram ответом на открытие) названо так же,
      // как само дело, а не просто видом «Сервер недоступен».
      const pushed = vi.spyOn(app.get(NotificationsService), 'push');
      await back();
      expect(await repo.findOpen(serverId, 'server_down')).toBeUndefined();
      expect(pushed.mock.calls.map(([n]) => n.title)).toContain(
        'Сервер недоступен — проверьте оплату · {server} — закрыт',
      );
      pushed.mockRestore();

      // Связь пропала сразу с несколькими серверами — общая причина вероятнее неоплаты одного из них:
      // оплату просим проверить, но в заголовок не ставим и причиной не называем.
      await db.execute(
        sql`insert into servers (name, host, port, ssh_user, agent_status, agent_last_seen_at)
            values ('inc-neighbour', '10.255.255.1', 22, 'root', 'offline', now() - interval '3 minutes')`,
      );
      await lose();
      const [fleet] = await open();
      expect(fleet?.title).toBe('Сервер недоступен · inc-host');
      expect(fleet?.detail).toContain('💳 Срок оплаты близко: Сервер «inc-host VPS»');
      expect(fleet?.detail).toContain(
        'Заодно проверьте оплату: срок оплаты этого сервера близко. Связь пропала сразу с несколькими серверами — это больше похоже на общую причину; если они у одного хостера, ею может быть и оплата.',
      );
      expect(fleet?.detail).not.toContain('Вероятнее всего');
      // Счёт раздельный: с одним сервером пропала связь, онлайн других нод панель упавшим не видела.
      expect(await svc.fleetTrouble({ serverId, names: ['inc-host'] })).toEqual({
        nodes: 0,
        linkedNodes: 0,
        servers: 1,
      });
      await back();

      // У соседа упал онлайн ноды (дело о падении онлайна с сервером) — связь с ним не пропадала.
      await db.execute(sql`update servers set agent_status = 'online' where name = 'inc-neighbour'`);
      await db.execute(sql`delete from incidents where server_name = 'inc-neighbour'`);
      const neighbour = (
        await db.execute<{ id: string }>(sql`select id from servers where name = 'inc-neighbour'`)
      ).rows[0]?.id as string;
      await repo.open({
        serverId: neighbour,
        serverName: 'inc-neighbour',
        kind: 'node_blocked',
        severity: 'warn',
        title: 'Резко упал онлайн, блокировка не подтвердилась · inc-neighbour',
        detail: 'Онлайн: 300 → 10 (−97 %) за 3 минуты',
        timeline: [{ at: new Date().toISOString(), by: 'auto', action: 'Обнаружено', result: 'detect' }],
      });
      // И нода, которую панель не нашла среди серверов (дело под именем ноды): та же ли это машина, что и
      // наш сервер, неизвестно — в детекции связи она «другим сервером» не считается.
      await repo.open({
        serverId: null,
        serverName: 'Нидерланды - 1',
        kind: 'node_blocked',
        severity: 'warn',
        title: 'Резко упал онлайн, блокировка не подтвердилась · Нидерланды - 1',
        detail: 'Онлайн: 120 → 4 (−97 %) за 2 минуты',
        timeline: [{ at: new Date().toISOString(), by: 'auto', action: 'Обнаружено', result: 'detect' }],
      });
      expect(await svc.fleetTrouble({ serverId, names: ['inc-host'] })).toEqual({
        nodes: 2,
        linkedNodes: 1,
        servers: 0,
      });
      await lose();
      const [withDrop] = await open();
      expect(withDrop?.title).toBe('Сервер недоступен · inc-host');
      expect(withDrop?.detail).toContain(
        'Заодно проверьте оплату: срок оплаты этого сервера близко. В это же время упал онлайн у других нод — это больше похоже на общую причину; если они у одного хостера, ею может быть и оплата.',
      );
      await back();
      // Осталась только нода без сервера — для детекции связи это не «сбой у нескольких»: оплата в заголовке.
      await db.execute(sql`delete from incidents where server_name = 'inc-neighbour'`);
      await lose();
      const [alone] = await open();
      expect(alone?.title).toBe('Сервер недоступен — проверьте оплату · inc-host');
      expect(alone?.detail).not.toContain('это больше похоже на общую причину');
      await db.execute(sql`delete from incidents where server_name = 'Нидерланды - 1'`);
      await db.execute(sql`delete from servers where name = 'inc-neighbour'`);
      await back();

      // Тот же случай через уточнение: сначала «Агент не в сети», потом порт SSH перестал открываться.
      svc.probeHost = probe;
      hostCache.clear();
      await db.execute(
        sql`update servers set agent_status = 'offline', ssh_ok = true where id = ${serverId}`,
      );
      await svc.evaluate(noMetrics);
      const first = await repo.findOpen(serverId, 'agent_offline');
      expect(first).toBeTruthy();
      svc.probeHost = async () => false;
      hostCache.clear();
      (svc as unknown as { reachCache: Map<string, unknown> }).reachCache.clear();
      await svc.evaluate(noMetrics);
      await svc.evaluate(noMetrics);
      const [refined] = await open();
      expect(refined?.id).toBe(first?.id);
      expect(refined?.title).toBe('Сервер недоступен — проверьте оплату · inc-host');
      expect(refined?.detail).toContain('💳 Срок оплаты близко: Сервер «inc-host VPS»');
    } finally {
      svc.probeHost = probe;
      bc.countryReach = reach;
      hostCache.clear();
      (svc as unknown as { reachCache: Map<string, unknown> }).reachCache.clear();
      await db.execute(sql`delete from billing_items where title in ('inc-host VPS', 'certwarden')`);
      await db.execute(sql`delete from incidents where server_name in ('inc-neighbour', 'Нидерланды - 1')`);
      await db.execute(sql`delete from servers where name = 'inc-neighbour'`);
      await back();
    }
  });

  it('куда сервер может выйти: заходим через другой сервер парка; «Ожидает агента» объясняется словами', async () => {
    const db = app.get<Db>(DB);
    const jumpRes = await agent
      .post('/api/servers')
      .set(CSRF_HEADER, csrf)
      .send({
        name: 'jump-host',
        host: '127.0.0.1',
        port: ssh.port,
        sshUser: SSH_USER,
        auth: { method: 'password', password: SSH_PASSWORD },
      })
      .expect(201);
    const jumpId = serverSchema.parse(jumpRes.body).id;
    try {
      // Фоновая автоустановка агента на новом сервере ставит «Ожидает агента» — дождёмся её, потом сбросим.
      for (let i = 0; i < 60; i += 1) {
        const r = await db.execute<{ agent_status: string }>(
          sql`select agent_status from servers where id = ${jumpId}`,
        );
        if (r.rows[0]?.agent_status === 'pending') break;
        await new Promise((res) => setTimeout(res, 100));
      }
      await db.execute(sql`update servers set ssh_ok = true, agent_status = 'online' where id = ${jumpId}`);
      const all = await app.get(ServersService).list();
      const me = all.find((x) => x.id === serverId);
      if (!me) throw new Error('нет сервера');
      const panelHost = new URL(process.env.PUBLIC_URL ?? 'http://localhost').hostname;
      ssh.egressClosed = ['ya.ru', 'vk.com', panelHost];
      const before = ssh.forwards;
      const rep = await app.get(EgressCheckService).check(me, all, ['jump-host']);
      expect(rep?.via).toBe('jump-host');
      expect(ssh.forwards).toBe(before + 1);
      expect(rep && egressVerdict(rep)).toBe('ru_and_panel_cut');

      // «Ожидает агента» дольше паузы → панель выясняет причину и пишет её в колокольчик (один раз).
      const mine = async () =>
        notificationsResponseSchema
          .parse((await agent.get('/api/notifications').expect(200)).body)
          .items.filter((n) => n.title.includes('не выходит на связь'));
      const was = (await mine()).length;
      await db.execute(
        sql`update servers set agent_status = 'pending', ssh_ok = true,
          agent_listen_port = null, agent_access_key_enc = null, agent_tls_cert = null
          where id = ${serverId}`,
      );
      await app.get(AgentPendingJob).run();
      const notes = await mine();
      expect(notes).toHaveLength(was + 1);
      expect(notes[0]?.body).toMatch(/причина в сети сервера, повторная установка не поможет/);
      expect(notes[0]?.body).toMatch(/• ya.ru — не подключается/);
      // Ждать дальше нечего: «Ожидает агента» не висит вечно — сервер становится «Агент не в сети».
      const after = serverSchema.parse((await agent.get(`/api/servers/${serverId}`).expect(200)).body);
      expect(after.agentStatus).toBe('offline');
      const gaveUp = auditListResponseSchema
        .parse(
          (await agent.get(`/api/audit?category=server&targetId=${serverId}&pageSize=50`).expect(200)).body,
        )
        .items.find((e) => e.action === 'server.agent.offline');
      expect(String(gaveUp?.metadata.reason)).toMatch(/не вышел на связь за 3 минуты после установки/);
      await app.get(AgentPendingJob).run();
      expect(await mine()).toHaveLength(was + 1);
      // Дело «Агент не в сети» открыто, но «Переустановить агента» не предложено: панель только что выяснила,
      // что повторная установка не поможет, и сама себе не противоречит.
      await app.get(IncidentsService).evaluate(noMetrics);
      const offline = await app.get(IncidentsRepository).findOpen(serverId, 'agent_offline');
      expect(offline).toBeTruthy();
      expect(offline?.proposal).toBeNull();
    } finally {
      ssh.egressClosed = [];
      await db.execute(sql`update servers set agent_status = 'online' where id = ${serverId}`);
      await agent.delete(`/api/servers/${jumpId}`).set(CSRF_HEADER, csrf);
    }
  });

  it('переустановка агента: дело «Агент не в сети» не закрывается как «проблема исчезла», пока агент не вышел на связь', async () => {
    const db = app.get<Db>(DB);
    const svc = app.get(IncidentsService);
    const repo = app.get(IncidentsRepository);
    const statusOf = async (id: string) => (await repo.findById(id))?.status;
    await db.execute(sql`update servers set agent_status = 'offline', ssh_ok = true where id = ${serverId}`);
    await svc.evaluate(noMetrics);
    const inc = await repo.findOpen(serverId, 'agent_offline');
    if (!inc) throw new Error('дело «Агент не в сети» не открылось');
    try {
      // «Переустановить агента»: идёт установка, потом панель ждёт агента — он всё ещё молчит.
      for (const st of ['installing', 'pending']) {
        await db.execute(sql`update servers set agent_status = ${st} where id = ${serverId}`);
        await svc.evaluate(noMetrics);
        expect(await statusOf(inc.id), st).toBe('open');
      }
      // Установка не удалась — статус вернулся в «не в сети»: дело то же, второго не заведено.
      await db.execute(sql`update servers set agent_status = 'offline' where id = ${serverId}`);
      await svc.evaluate(noMetrics);
      expect((await repo.findOpen(serverId, 'agent_offline'))?.id).toBe(inc.id);

      // Агент вышел на связь, но действие по делу ещё идёт: итог запишет само действие, а не «проблема исчезла».
      await repo.update(inc.id, { attempts: [orphanAttempt(0)] });
      await db.execute(sql`update servers set agent_status = 'online' where id = ${serverId}`);
      await svc.evaluate(noMetrics);
      expect(await statusOf(inc.id)).toBe('open');

      // Действие закончилось, агент на связи — дело закрывается само.
      await repo.update(inc.id, { attempts: [] });
      await svc.evaluate(noMetrics);
      expect(await repo.findById(inc.id)).toMatchObject({ status: 'resolved', resolvedBy: 'auto' });
    } finally {
      await db.execute(sql`update servers set agent_status = 'online' where id = ${serverId}`);
      await db.execute(
        sql`update incidents set status = 'resolved', resolved_at = now(), attempts = '[]'::jsonb where id = ${inc.id}`,
      );
    }
  });

  it('«Переустановить агента» не помогло: дело остаётся открытым, предлагает следующий шаг и переживает «Ожидает агента»', async () => {
    const db = app.get<Db>(DB);
    const svc = app.get(IncidentsService);
    const repo = app.get(IncidentsRepository);
    const agentStatus = async () =>
      serverSchema.parse((await agent.get(`/api/servers/${serverId}`).expect(200)).body).agentStatus;
    await db.execute(sql`update servers set agent_status = 'offline', ssh_ok = true where id = ${serverId}`);
    await svc.evaluate(noMetrics);
    const inc = await repo.findOpen(serverId, 'agent_offline');
    if (!inc) throw new Error('дело «Агент не в сети» не открылось');
    try {
      // Подтверждаем предложенный шаг: установка проходит, но агент на связь не выходит.
      await agent
        .post(`/api/incidents/${inc.id}/actions/agent_reinstall/run`)
        .set(CSRF_HEADER, csrf)
        .expect(202);
      // Тик детекции попал на само действие — дело не трогает.
      await svc.evaluate(noMetrics);
      const done = await settled(inc.id);
      expect(done.attempts[0]).toMatchObject({ action: 'agent_reinstall', status: 'not_helped' });
      expect(done.status).not.toBe('resolved');
      // Раньше к этому моменту дело уже было закрыто как «проблема исчезла», и следующий шаг не предлагался.
      expect(done.proposal).toMatchObject({ action: 'agent_logs', level: 'T3' });
      expect(await agentStatus()).toBe('pending');

      // Панель ждёт агента — следующие тики дело не закрывают.
      await svc.evaluate(noMetrics);
      expect((await repo.findById(inc.id))?.status).not.toBe('resolved');
      // Ждать дальше нечего: «Ожидает агента» → «Агент не в сети». Дело всё то же, второго нет.
      await app.get(AgentPendingJob).run();
      expect(await agentStatus()).toBe('offline');
      await svc.evaluate(noMetrics);
      const open = incidentsListResponseSchema
        .parse((await agent.get('/api/incidents?status=open').expect(200)).body)
        .items.filter((i) => i.serverName === 'inc-host' && i.kind === 'agent_offline');
      expect(open.map((i) => i.id)).toEqual([inc.id]);

      // Агент вышел на связь — дело закрывается само.
      await db.execute(sql`update servers set agent_status = 'online' where id = ${serverId}`);
      await svc.evaluate(noMetrics);
      expect(await repo.findById(inc.id)).toMatchObject({ status: 'resolved', resolvedBy: 'auto' });
    } finally {
      await app.get(IncidentRunnerService).settle();
      await db.execute(sql`update servers set agent_status = 'online' where id = ${serverId}`);
      await db.execute(
        sql`update incidents set status = 'resolved', resolved_at = now() where id = ${inc.id} and status <> 'resolved'`,
      );
    }
  });

  it('«SSH недоступен»: одна неудачная проверка дела не заводит — только неудача, которую подтвердили повторные проверки', async () => {
    const db = app.get<Db>(DB);
    const svc = app.get(IncidentsService);
    const repo = app.get(IncidentsRepository);
    const marks = (svc as unknown as { sshDownSince: Map<string, number> }).sshDownSince;
    const threshold = svc.sshDownForMs;
    // В тестах порог нулевой (как у «Агент не в сети»); здесь проверяем настоящий — две минуты.
    svc.sshDownForMs = 120_000;
    const failedAt = (seconds: number) =>
      db.execute(
        sql`update servers set ssh_ok = false, last_ssh_check_at = now() + (${seconds} * interval '1 second') where id = ${serverId}`,
      );
    const answered = () =>
      db.execute(
        sql`update servers set ssh_ok = true, last_ssh_check_at = now(), last_ssh_ok_at = now() where id = ${serverId}`,
      );
    try {
      await db.execute(sql`update servers set agent_status = 'online' where id = ${serverId}`);
      await answered();
      await svc.evaluate(noMetrics);

      // Автопроверка один раз не прошла (потеря пакетов, отказ sshd из-за ботов) — это ещё не «недоступен».
      await failedAt(0);
      await svc.evaluate(noMetrics);
      expect(await repo.findOpen(serverId, 'ssh_down')).toBeUndefined();
      // Перепроверка через полминуты тоже не прошла — порог ещё не вышел.
      await failedAt(30);
      await svc.evaluate(noMetrics);
      expect(await repo.findOpen(serverId, 'ssh_down')).toBeUndefined();
      // SSH ответил: серия неудач кончилась, дела так и не было.
      await answered();
      await svc.evaluate(noMetrics);
      expect(marks.has(serverId)).toBe(false);

      // Новая серия неудач. Между двумя тиками детекции SSH успел ответить и снова пропасть — отсчёт
      // начинается с проверки после этого ответа, а не с самой первой неудачи.
      await failedAt(0);
      await svc.evaluate(noMetrics);
      await db.execute(
        sql`update servers set ssh_ok = false, last_ssh_ok_at = now() + interval '60 seconds',
            last_ssh_check_at = now() + interval '130 seconds' where id = ${serverId}`,
      );
      await svc.evaluate(noMetrics);
      expect(await repo.findOpen(serverId, 'ssh_down')).toBeUndefined();
      await failedAt(220);
      await svc.evaluate(noMetrics);
      expect(await repo.findOpen(serverId, 'ssh_down')).toBeUndefined();
      // SSH не отвечает дольше порога: последняя неудачная проверка — через две минуты после начала серии.
      await failedAt(255);
      await svc.evaluate(noMetrics);
      const inc = await repo.findOpen(serverId, 'ssh_down');
      expect(inc).toMatchObject({ severity: 'crit', title: 'SSH недоступен · inc-host' });

      // Панель перезапустили (отметки в памяти нет) — открытое дело не закрывается, пока SSH не ответил.
      marks.clear();
      await svc.evaluate(noMetrics);
      expect((await repo.findOpen(serverId, 'ssh_down'))?.id).toBe(inc?.id);
      await answered();
      await svc.evaluate(noMetrics);
      expect(await repo.findOpen(serverId, 'ssh_down')).toBeUndefined();
      expect(await repo.findById(inc?.id ?? '')).toMatchObject({ status: 'resolved', resolvedBy: 'auto' });
    } finally {
      svc.sshDownForMs = threshold;
      await answered();
      await svc.evaluate(noMetrics);
    }
  });

  it('с панели сервер молчит, а из Германии порт SSH открыт → одно дело «Недоступен из части сетей», не «Сервер недоступен»', async () => {
    const db = app.get<Db>(DB);
    const svc = app.get(IncidentsService);
    const repo = app.get(IncidentsRepository);
    const bc = app.get(NodeBlockCheckService);
    const probe = svc.probeHost;
    const reach = bc.countryReach;
    const clear = () => {
      (svc as unknown as { hostCache: Map<string, unknown> }).hostCache.clear();
      (svc as unknown as { reachCache: Map<string, unknown> }).reachCache.clear();
    };
    try {
      await db.execute(
        sql`update servers set agent_status = 'offline', ssh_ok = true where id = ${serverId}`,
      );
      await svc.evaluate(noMetrics);
      expect(await repo.findOpen(serverId, 'agent_offline')).toBeDefined();

      // Порт открыт отовсюду, включая саму панель, а SSH не пускает: дорога к серверу есть — это не
      // «часть сетей» и не «сервер недоступен», а обычные «Агент не в сети» и «SSH недоступен».
      await db.execute(sql`update servers set ssh_ok = false where id = ${serverId}`);
      bc.countryReach = async () => ({
        results: [
          { from: 'Мост', country: 'RU', open: true },
          { from: 'Германия-1', country: 'DE', open: true },
        ],
        blind: null,
      });
      clear();
      await svc.evaluate(noMetrics);
      await svc.evaluate(noMetrics);
      const everywhere = incidentsListResponseSchema
        .parse((await agent.get('/api/incidents?status=open').expect(200)).body)
        .items.filter((i) => i.serverName === 'inc-host');
      expect(everywhere.map((i) => i.kind).sort()).toEqual(['agent_offline', 'ssh_down']);
      await db.execute(sql`update servers set ssh_ok = true where id = ${serverId}`);
      clear();
      await svc.evaluate(noMetrics);
      await svc.evaluate(noMetrics);

      svc.probeHost = async () => false;
      bc.countryReach = async () => ({
        results: [
          { from: 'Мост', country: 'RU', open: false },
          { from: 'Германия-1', country: 'DE', open: true },
          { from: 'Нидерланды', country: 'NL', open: true },
        ],
        blind: null,
      });
      clear();
      await svc.evaluate(noMetrics);
      await svc.evaluate(noMetrics);
      const open = incidentsListResponseSchema
        .parse((await agent.get('/api/incidents?status=open').expect(200)).body)
        .items.filter((i) => i.serverName === 'inc-host');
      expect(open.map((i) => i.kind)).toEqual(['node_blocked']);
      const inc = open[0];
      expect(inc?.title).toMatch(/^Недоступен из части сетей/);
      expect(inc?.detail.startsWith(PARTIAL_MARK)).toBe(true);
      expect(inc?.detail).toMatch(/• Мост — порт не отвечает/);
      expect(inc?.detail).toMatch(/• Германия-1 — порт открыт/);
      expect(inc?.detail).toMatch(/не отвечает с Мост/);
      expect(inc?.detail).toMatch(/Куда сервер может выйти/);
      expect(inc?.detail).toMatch(/• google.com — открыто/);
      expect(inc?.timeline.map((e) => e.action).join('\n')).toMatch(/Присоединено: «Агент не в сети»/);

      // Повторный тик — второго дела нет.
      clear();
      await svc.evaluate(noMetrics);
      const again = incidentsListResponseSchema
        .parse((await agent.get('/api/incidents?status=open').expect(200)).body)
        .items.filter((i) => i.serverName === 'inc-host');
      expect(again.map((i) => i.kind)).toEqual(['node_blocked']);

      // Закрыт отовсюду → дело становится «Сервер недоступен», частичное присоединяется к нему. «Связь
      // восстановилась» при этом не пишется: связь как раз пропала совсем.
      const partialId = inc?.id ?? '';
      bc.countryReach = async () => ({
        results: [
          { from: 'Мост', country: 'RU', open: false },
          { from: 'Германия-1', country: 'DE', open: false },
        ],
        blind: null,
      });
      clear();
      await svc.evaluate(noMetrics);
      await svc.evaluate(noMetrics);
      const down = incidentsListResponseSchema
        .parse((await agent.get('/api/incidents?status=open').expect(200)).body)
        .items.filter((i) => i.serverName === 'inc-host');
      expect(down.map((i) => i.kind)).toEqual(['server_down']);
      expect(down[0]?.detail).toMatch(/ни из одной страны/);
      const merged = incidentSchema.parse((await agent.get(`/api/incidents/${partialId}`).expect(200)).body);
      const closedWith = merged.timeline.map((e) => e.action).join('\n');
      expect(closedWith).toContain('Объединено с делом «Сервер недоступен»');
      expect(closedWith).not.toContain('Связь восстановилась');

      // Проверяли одни российские серверы: «ни из одной страны» и «вероятнее всего» — неправда, из-за рубежа
      // порт не проверен (это может быть и блокировка адреса из России).
      await db.execute(sql`delete from incidents where server_id = ${serverId}`);
      await db.execute(
        sql`insert into billing_items (kind, title, server_ids, amount_minor, currency, period_unit, period_count, paid_until)
            values ('server', 'inc-host RU-only', ${JSON.stringify([serverId])}::jsonb, 45100, 'RUB', 'month', 1, now() - interval '1 day')`,
      );
      bc.countryReach = async () => ({
        results: [
          { from: 'Мост', country: 'RU', open: false },
          { from: 'Россия-2', country: 'RU', open: false },
        ],
        blind: null,
      });
      clear();
      await svc.evaluate(noMetrics);
      await svc.evaluate(noMetrics);
      const ruOnly = await repo.findOpen(serverId, 'server_down');
      expect(ruOnly?.detail).toContain(
        'не отвечает ни с одного проверяющего сервера, но все они в России; из-за рубежа порт не проверен:',
      );
      expect(ruOnly?.detail).not.toContain('ни из одной страны');
      expect(ruOnly?.detail).toContain(
        'Проверьте оплату: из-за рубежа порт не проверен, а оплата просрочена',
      );
      expect(ruOnly?.detail).not.toContain('Вероятнее всего');
      await db.execute(sql`delete from billing_items where title = 'inc-host RU-only'`);

      // Все проверяющие видят порт, не видит только панель: «закрыт из части стран» было бы неправдой.
      await db.execute(sql`delete from incidents where server_id = ${serverId}`);
      bc.countryReach = async () => ({
        results: [
          { from: 'Мост', country: 'RU', open: true },
          { from: 'Германия-1', country: 'DE', open: true },
        ],
        blind: null,
      });
      clear();
      await svc.evaluate(noMetrics);
      await svc.evaluate(noMetrics);
      const panelCut = await repo.findOpen(serverId, 'node_blocked');
      expect(panelCut?.detail).toContain(
        'Похоже: закрыт путь между сервером и панелью — со всех проверяющих серверов (Мост, Германия-1) порт открыт, а с сервера панели не отвечает',
      );
      expect(panelCut?.detail).not.toContain('в этих странах');

      // Порт открылся и с панели, а агент молчит и SSH не пускает — дело закрывается словами о том, что есть.
      svc.probeHost = probe;
      await db.execute(sql`update servers set ssh_ok = false where id = ${serverId}`);
      clear();
      await svc.evaluate(noMetrics);
      await svc.evaluate(noMetrics);
      const reopened = incidentSchema.parse(
        (await agent.get(`/api/incidents/${panelCut?.id}`).expect(200)).body,
      );
      expect(reopened.status).toBe('resolved');
      const why = reopened.timeline.map((e) => e.action).join('\n');
      expect(why).toContain(
        'Порт SSH снова открыт отовсюду, в том числе с сервера панели. Агент пока молчит, и по SSH панель зайти не может',
      );
      expect(why).not.toContain('агент выходит на связь');
      await db.execute(sql`update servers set ssh_ok = true where id = ${serverId}`);
      svc.probeHost = async () => false;

      // Серверы парка есть, но панель не зашла ни на один: это сбой обзора самой панели. Пустая
      // перепроверка не доказывает падение сервера и не должна создавать ложное критичное дело.
      await db.execute(sql`delete from incidents where server_id = ${serverId}`);
      bc.countryReach = async () => ({ results: [], blind: 'ssh' });
      clear();
      await svc.evaluate(noMetrics);
      const blind = incidentsListResponseSchema
        .parse((await agent.get('/api/incidents?status=open').expect(200)).body)
        .items.filter((i) => i.serverName === 'inc-host');
      expect(blind).toEqual([]);

      // Агент вернулся — всё закрыто.
      svc.probeHost = probe;
      bc.countryReach = reach;
      await db.execute(sql`update servers set agent_status = 'online' where id = ${serverId}`);
      clear();
      await svc.evaluate(noMetrics);
      expect(await repo.findOpen(serverId, 'server_down')).toBeUndefined();
      expect(await repo.findOpen(serverId, 'node_blocked')).toBeUndefined();
    } finally {
      svc.probeHost = probe;
      bc.countryReach = reach;
      clear();
    }
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

  it('закрытие дела сначала останавливает SSH-команду и только затем снимает занятость сервера', async () => {
    const db = app.get<Db>(DB);
    await db.execute(sql`update servers set agent_status = 'online' where id = ${serverId}`);
    const repo = app.get(IncidentsRepository);
    const opened = await repo.open({
      serverId,
      serverName: 'inc-host',
      kind: 'disk_high',
      severity: 'warn',
      title: 'Диск заполняется · inc-host',
      detail: 'Проверка отмены.',
      timeline: [{ at: new Date().toISOString(), by: 'auto', action: 'Обнаружено', result: 'detect' }],
    });
    const id = opened?.id ?? '';
    app.get(IncidentMetricsService).setForTest(serverId, { disk: 94 });
    ssh.holdAptClean = true;
    const abortedBefore = ssh.aptCleanAborted;
    try {
      await agent.post(`/api/incidents/${id}/actions/apt_clean/run`).set(CSRF_HEADER, csrf).expect(202);
      for (let i = 0; i < 50 && ssh.aptCleanStarted === 0; i += 1)
        await new Promise((resolve) => setTimeout(resolve, 10));
      expect(ssh.aptCleanStarted).toBeGreaterThan(0);
      const resolved = incidentSchema.parse(
        (await agent.post(`/api/incidents/${id}/resolve`).set(CSRF_HEADER, csrf).expect(200)).body,
      );
      expect(ssh.aptCleanAborted).toBeGreaterThan(abortedBefore);
      expect(resolved.attempts[0]).toMatchObject({ status: 'failed' });
      expect(resolved.attempts[0]?.steps.find((step) => step.key === 'action')?.note).toContain(
        'закрыт администратором',
      );
    } finally {
      ssh.holdAptClean = false;
    }
  });

  it('осмотр диска: поток вывода не затирает статус шагов; чистить нечего — чистка не предлагается', async () => {
    const db = app.get<Db>(DB);
    await db.execute(sql`update servers set agent_status = 'online' where id = ${serverId}`);
    const repo = app.get(IncidentsRepository);
    ssh.inspectTmpGb = 0;
    // Несколько инцидентов подряд: гонка проявляется не всегда, серия её ловит
    for (let n = 0; n < 4; n++) {
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
      app.get(IncidentMetricsService).setForTest(serverId, { disk: 94 });
      await agent.post(`/api/incidents/${id}/actions/apt_clean/run`).set(CSRF_HEADER, csrf).expect(202);
      const done = await settled(id);
      const inspect = done.attempts.find((a) => a.action === 'disk_inspect');
      expect(inspect?.status, `серия ${n}`).toBe('done');
      // ни один шаг не остался «выполняется»
      expect(
        inspect?.steps.map((st) => st.status),
        `серия ${n}`,
      ).toEqual(['ok', 'ok', 'skipped', 'skipped']);
      expect(inspect?.log).toContain('Временных файлов старше часа: 0.0 ГБ');
      expect(inspect?.log).toContain('159.0G');
      // чистить нечего — предложения нет, цепочка честно кончилась
      expect(done.proposal).toBeNull();
      expect(done.timeline.some((e) => e.action.includes('исчерпаны'))).toBe(true);
      await agent.post(`/api/incidents/${id}/resolve`).set(CSRF_HEADER, csrf).expect(200);
    }
    ssh.inspectTmpGb = 3.5;
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
    // после осмотра — предложение убрать временные файлы, но только с подтверждением
    expect(done.proposal).toMatchObject({ action: 'tmp_clean', level: 'T2' });
    expect(done.proposal?.reason).toContain('3.5 ГБ временных файлов старше часа');

    // подтверждаем: /tmp чистится, диск всё ещё занят → цепочка кончилась
    await agent.post(`/api/incidents/${id}/actions/tmp_clean/run`).set(CSRF_HEADER, csrf).expect(202);
    const after = await settled(id);
    expect(after.attempts[2]).toMatchObject({ action: 'tmp_clean', status: 'not_helped' });
    expect(ssh.execLog.some((c) => c.includes('/var/tmp') && c.includes('-mmin +60'))).toBe(true);
    expect(after.timeline.some((e) => e.result === 'escalate' && e.action.includes('исчерпаны'))).toBe(true);
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

  /** Дело «Диск заполняется» на тестовом сервере — как его завела бы детекция. */
  const openDisk = async () => {
    const row = await app.get(IncidentsRepository).open({
      serverId,
      serverName: 'inc-host',
      kind: 'disk_high',
      severity: 'warn',
      title: 'Диск заполняется · inc-host',
      detail: 'Диск держится выше порога.',
      timeline: [{ at: new Date().toISOString(), by: 'auto', action: 'Обнаружено', result: 'detect' }],
    });
    if (!row) throw new Error('дело не открылось: прежнее того же вида ещё не закрыто');
    return row;
  };
  const attemptsOf = (inc: { attempts: Array<{ action: string; by: string; status: string }> }) =>
    inc.attempts.map((a) => `${a.action}:${a.by}:${a.status}`);
  /** Режим «Само» для диска и ноды; прошлые автопочинки этого набора паузу не задают. */
  const autoMode = async () => {
    const db = app.get<Db>(DB);
    await db.execute(sql`update servers set agent_status = 'online' where id = ${serverId}`);
    await db.execute(sql`update incidents set last_autofix_at = null where server_id = ${serverId}`);
    await agent
      .patch('/api/incidents/policy')
      .set(CSRF_HEADER, csrf)
      .send({ autofixEnabled: true, policy: { disk_high: 'auto', node_down: 'auto' } })
      .expect(200);
  };
  const askMode = async () => {
    await agent
      .patch('/api/incidents/policy')
      .set(CSRF_HEADER, csrf)
      .send({ autofixEnabled: false, policy: { disk_high: 'ask', node_down: 'ask' } })
      .expect(200);
    const open = incidentsListResponseSchema.parse(
      (await agent.get('/api/incidents?status=open').expect(200)).body,
    );
    for (const i of open.items.filter((x) => x.kind === 'disk_high' || x.kind === 'node_down'))
      await agent.post(`/api/incidents/${i.id}/resolve`).set(CSRF_HEADER, csrf).expect(200);
  };
  /** Прошло 31 минута с последней автопочинки: сдвигаем её отметку в прошлое. */
  const pausePassed = async () =>
    app
      .get<Db>(DB)
      .execute(
        sql`update incidents set last_autofix_at = now() - interval '31 minutes' where server_id = ${serverId} and last_autofix_at is not null`,
      );
  const PAUSE_REASON =
    'панель недавно уже чинила этот сигнал на сервере и следующую починку запустит сама, когда пройдёт пауза между автопочинками';
  const timelineOf = (inc: { timeline: Array<{ action: string }> }, start: string) =>
    inc.timeline.filter((e) => e.action.startsWith(start)).length;

  it('пауза между автопочинками считается по серверу и сигналу: новое дело в паузу не чинится само, после паузы — чинится', async () => {
    const runner = app.get(IncidentRunnerService);
    const metrics = app.get(IncidentMetricsService);
    const svc = app.get(IncidentsService);
    await autoMode();
    try {
      // Диск заполнился — панель сама освободила, дело закрыто.
      metrics.setForTest(serverId, { disk: 96 });
      const first = await openDisk();
      const tick = runner.autoTick();
      metrics.setForTest(serverId, { disk: 50 });
      await tick;
      const fixed = await settled(first.id);
      expect(attemptsOf(fixed)).toEqual(['free_disk:auto:helped']);
      expect(fixed.status).toBe('resolved');

      // Через минуту диск заполнился снова — новое дело того же сигнала на том же сервере. Пауза
      // (30 минут) ещё идёт: сама панель шаг не запускает, а предлагает его и говорит почему.
      metrics.setForTest(serverId, { disk: 96 });
      const second = await openDisk();
      expect(await runner.onOpened(second)).toBe('proposed');
      let inc = await settled(second.id);
      expect(inc.attempts).toHaveLength(0);
      expect(inc.proposal).toMatchObject({
        action: 'free_disk',
        level: 'T1',
        reason: PAUSE_REASON,
        autoAfterPause: true,
      });
      expect(timelineOf(inc, 'Отложено паузой между автопочинками: Освободить диск')).toBe(1);
      // Тики в паузу ничего не запускают и предложение не повторяют.
      await runner.autoTick();
      await runner.autoTick();
      inc = await settled(second.id);
      expect(inc.attempts).toHaveLength(0);
      expect(timelineOf(inc, 'Отложено паузой')).toBe(1);

      // Другой сигнал на том же сервере паузой не задержан: упавший контейнер панель поднимает сразу.
      svc.recordNodeState(serverId, 'stopped');
      await svc.evaluate(noMetrics);
      const node = incidentsListResponseSchema
        .parse((await agent.get('/api/incidents?status=open').expect(200)).body)
        .items.find((i) => i.kind === 'node_down');
      svc.recordNodeState(serverId, 'running');
      const raised = await settled(node?.id ?? '');
      expect(attemptsOf(raised)).toEqual(['node_up:auto:helped']);

      // Пауза прошла — предложенный шаг панель запускает сама, подтверждения не ждёт.
      await pausePassed();
      const tick2 = runner.autoTick();
      metrics.setForTest(serverId, { disk: 50 });
      await tick2;
      inc = await settled(second.id);
      expect(attemptsOf(inc)).toEqual(['free_disk:auto:helped']);
      expect(inc.proposal).toBeNull();
      expect(inc.status).toBe('resolved');

      // Минута «вдруг поднимется само» у свежего дела (в тестах её нет — дело «открыто» на минуту вперёд).
      // Пауза кончится раньше этой минуты — панель просто ждёт и потом чинит сама, как обещает уведомление.
      const db = app.get<Db>(DB);
      const repo = app.get(IncidentsRepository);
      const lastFixAgo = (interval: string) =>
        db.execute(
          sql`update incidents set last_autofix_at = now() - ${interval}::interval where id = ${second.id}`,
        );
      const third = await openDisk();
      await db.execute(
        sql`update incidents set opened_at = now() + interval '60 seconds' where id = ${third.id}`,
      );
      const fresh = async () => {
        const row = await repo.findById(third.id);
        if (!row) throw new Error('дело пропало');
        return row;
      };
      await lastFixAgo('29 minutes 30 seconds');
      expect(await runner.onOpened(await fresh())).toBe('waiting');
      expect((await fresh()).proposal).toBeNull();
      // Пауза длиннее этой минуты — «починим через минуту» было бы неправдой: шаг предложен сразу.
      await lastFixAgo('10 minutes');
      expect(await runner.onOpened(await fresh())).toBe('proposed');
      expect((await fresh()).proposal).toMatchObject({ reason: PAUSE_REASON, autoAfterPause: true });
    } finally {
      await askMode();
    }
  });

  it('пауза между автопочинками стоит между заходами, а не между шагами одной цепочки; ручной запуск и осмотр её не сдвигают', async () => {
    const runner = app.get(IncidentRunnerService);
    const metrics = app.get(IncidentMetricsService);
    const repo = app.get(IncidentsRepository);
    await autoMode();
    try {
      // Диск не освобождается: «Освободить диск» не поможет. Следующий безопасный шаг того же дела панель
      // запускает сразу — это тот же заход, ждать полчаса с почти полным диском незачем.
      metrics.setForTest(serverId, { disk: 94 });
      const first = await openDisk();
      await runner.autoTick();
      let inc = await settled(first.id);
      expect(attemptsOf(inc)).toEqual([
        'free_disk:auto:not_helped',
        'apt_clean:auto:not_helped',
        'disk_inspect:auto:done',
      ]);
      expect(inc.proposal).toMatchObject({ action: 'tmp_clean', level: 'T2' });
      expect(inc.proposal?.autoAfterPause).toBeUndefined();

      // Отсчёт паузы — от последней починки, которую панель запустила сама («Очистить кэш apt»): осмотр
      // (только чтение) его не сдвигает.
      const [, apt, inspect] = inc.attempts;
      const afterChain = await repo.lastAutofixAt(serverId, 'disk_high');
      expect(Math.abs((afterChain?.getTime() ?? 0) - Date.parse(apt?.startedAt ?? ''))).toBeLessThan(1_000);
      expect(afterChain?.getTime() ?? 0).toBeLessThanOrEqual(Date.parse(inspect?.startedAt ?? ''));

      // Владелец подтверждает следующий шаг сам — пауза его не ограничивает и от него не отсчитывается.
      await agent.post(`/api/incidents/${first.id}/actions/tmp_clean/run`).set(CSRF_HEADER, csrf).expect(202);
      inc = await settled(first.id);
      expect(attemptsOf(inc)[3]).toMatch(/^tmp_clean:manual:/);
      expect((await repo.lastAutofixAt(serverId, 'disk_high'))?.getTime()).toBe(afterChain?.getTime());
    } finally {
      await askMode();
    }
  });

  it('пауза между автопочинками: отложенный шаг перестаёт обещать «запустит сама», когда режим «Само» больше не действует', async () => {
    const runner = app.get(IncidentRunnerService);
    const metrics = app.get(IncidentMetricsService);
    const LAPSED =
      'шаг был отложен паузой между автопочинками, но сама панель его уже не запустит: режим «Само» для этого сигнала сейчас не действует';
    /** Новое дело диска сразу после автопочинки прошлого: шаг отложен паузой. */
    const deferred = async () => {
      metrics.setForTest(serverId, { disk: 96 });
      const fixedRow = await openDisk();
      const tick = runner.autoTick();
      metrics.setForTest(serverId, { disk: 50 });
      await tick;
      expect((await settled(fixedRow.id)).status).toBe('resolved');
      metrics.setForTest(serverId, { disk: 96 });
      const row = await openDisk();
      expect(await runner.onOpened(row)).toBe('proposed');
      expect((await settled(row.id)).proposal?.autoAfterPause).toBe(true);
      return row;
    };
    await autoMode();
    try {
      // Пока шаг ждал паузу, сигнал перевели в «Спросить»: обещание снято, шаг ждёт только подтверждения.
      const first = await deferred();
      await agent
        .patch('/api/incidents/policy')
        .set(CSRF_HEADER, csrf)
        .send({ policy: { disk_high: 'ask' } })
        .expect(200);
      await runner.autoTick();
      let inc = await settled(first.id);
      expect(inc.attempts).toHaveLength(0);
      expect(inc.proposal).toMatchObject({ action: 'free_disk', level: 'T1', reason: LAPSED });
      expect(inc.proposal?.autoAfterPause).toBeUndefined();
      expect(timelineOf(inc, 'Отложенный шаг ждёт подтверждения')).toBe(1);
      // Вернули «Само» и пауза прошла — шаг уже обычное предложение: сама панель его не запускает и
      // запись в ленте не повторяет.
      await agent
        .patch('/api/incidents/policy')
        .set(CSRF_HEADER, csrf)
        .send({ policy: { disk_high: 'auto' } })
        .expect(200);
      await pausePassed();
      await runner.autoTick();
      inc = await settled(first.id);
      expect(inc.attempts).toHaveLength(0);
      expect(inc.proposal?.reason).toBe(LAPSED);
      expect(timelineOf(inc, 'Отложенный шаг ждёт подтверждения')).toBe(1);
      await agent.post(`/api/incidents/${first.id}/resolve`).set(CSRF_HEADER, csrf).expect(200);

      // То же, когда автопочинку целиком поставили на паузу на время работ.
      await app
        .get<Db>(DB)
        .execute(sql`update incidents set last_autofix_at = null where server_id = ${serverId}`);
      const second = await deferred();
      await agent
        .patch('/api/incidents/policy')
        .set(CSRF_HEADER, csrf)
        .send({ pauseMinutes: 60 })
        .expect(200);
      await runner.autoTick();
      inc = await settled(second.id);
      expect(inc.attempts).toHaveLength(0);
      expect(inc.proposal).toMatchObject({ action: 'free_disk', reason: LAPSED });
      expect(inc.proposal?.autoAfterPause).toBeUndefined();
    } finally {
      await agent.patch('/api/incidents/policy').set(CSRF_HEADER, csrf).send({ pauseMinutes: 0 }).expect(200);
      await askMode();
    }
  });

  it('пауза между автопочинками отсчитывается от починки, которая началась: запуск, остановленный пред-проверкой, её не сдвигает', async () => {
    const runner = app.get(IncidentRunnerService);
    const metrics = app.get(IncidentMetricsService);
    const repo = app.get(IncidentsRepository);
    await autoMode();
    try {
      // Диск переполнен: пред-проверка не пускает «Освободить диск» — панель ничего не выполнила.
      metrics.setForTest(serverId, { disk: 100 });
      const first = await openDisk();
      await runner.autoTick();
      let inc = await settled(first.id);
      expect(attemptsOf(inc)).toEqual(['free_disk:auto:precheck_failed']);
      expect(inc.proposal).toMatchObject({ action: 'free_disk', level: 'T2' });
      expect(await repo.lastAutofixAt(serverId, 'disk_high')).toBeNull();
      await agent.post(`/api/incidents/${first.id}/resolve`).set(CSRF_HEADER, csrf).expect(200);

      // Новое дело того же сигнала сразу после этого панель чинит сама: починки не было — паузы нет.
      metrics.setForTest(serverId, { disk: 96 });
      const second = await openDisk();
      const tick = runner.autoTick();
      metrics.setForTest(serverId, { disk: 50 });
      await tick;
      inc = await settled(second.id);
      expect(attemptsOf(inc)).toEqual(['free_disk:auto:helped']);
      expect(await repo.lastAutofixAt(serverId, 'disk_high')).not.toBeNull();
    } finally {
      await askMode();
    }
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
    expect(done.attempts[0]?.steps[2]?.note).toContain('контейнер ноды стабильно работает');
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

  it('переименование сервера: новое имя в инциденте и в уже созданных уведомлениях', async () => {
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
    await app.get(NotificationsService).push({
      severity: 'warn',
      title: 'Диск заполняется · {server}: ждёт подтверждения',
      server: { id: serverId, name: 'inc-host' },
    });
    await agent
      .patch(`/api/servers/${serverId}`)
      .set(CSRF_HEADER, csrf)
      .send({ name: 'renamed-host' })
      .expect(200);
    const inc = incidentSchema.parse((await agent.get(`/api/incidents/${opened?.id}`).expect(200)).body);
    expect(inc.serverName).toBe('renamed-host');
    expect(inc.title).toBe('Диск заполняется · renamed-host');
    const notes = notificationsResponseSchema.parse((await agent.get('/api/notifications').expect(200)).body);
    expect(notes.items[0]?.title).toBe('Диск заполняется · renamed-host: ждёт подтверждения');
    // обратно, чтобы остальные тесты видели прежнее имя
    await agent
      .patch(`/api/servers/${serverId}`)
      .set(CSRF_HEADER, csrf)
      .send({ name: 'inc-host' })
      .expect(200);
    await agent.post(`/api/incidents/${opened?.id}/resolve`).set(CSRF_HEADER, csrf).expect(200);
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

  it('список решённых по смещению: строки с нужного места, за концом списка — пусто, а не «последняя страница»', async () => {
    const db = app.get<Db>(DB);
    // Двенадцать решённых с шагом в минуту, все новее остальных дел этого набора: «Сбой 1» — самый свежий.
    for (let i = 1; i <= 12; i += 1)
      await db.execute(
        sql`insert into incidents (server_name, kind, severity, status, title, opened_at, resolved_at, resolved_by)
            values ('offset-host', 'cpu_high', 'warn', 'resolved', ${`Сбой ${i} · offset-host`}, now() + (${13 - i} || ' minutes')::interval, now(), 'auto')`,
      );
    try {
      const get = async (query: string) => {
        const res = incidentsListResponseSchema.parse(
          (await agent.get(`/api/incidents?status=resolved&${query}`).expect(200)).body,
        );
        return { ...res, mine: res.items.filter((i) => i.serverName === 'offset-host').map((i) => i.title) };
      };
      const all = await get('pageSize=100');
      expect(all.mine).toHaveLength(12);
      expect(all.items.slice(0, 3).map((i) => i.title)).toEqual([
        'Сбой 1 · offset-host',
        'Сбой 2 · offset-host',
        'Сбой 3 · offset-host',
      ]);
      // Страницы реестра разной длины: следующая начинается ровно с той строки, где кончилась показанная.
      const mid = await get('offset=3&pageSize=5');
      expect(mid.items.map((i) => i.title)).toEqual([4, 5, 6, 7, 8].map((n) => `Сбой ${n} · offset-host`));
      expect(mid.total).toBe(all.total);
      // За концом списка — пусто и общее число: клиент сам решает, куда вернуться.
      const past = await get(`offset=${all.total + 5}&pageSize=5`);
      expect(past.items).toEqual([]);
      expect(past.total).toBe(all.total);
      // По номеру страницы — как раньше: за концом отдаётся последняя существующая.
      const paged = await get('page=999&pageSize=5');
      expect(paged.items.length).toBeGreaterThan(0);
      expect(paged.page).toBe(paged.totalPages);
      await agent.get('/api/incidents?status=resolved&offset=-1&pageSize=5').expect(400);
    } finally {
      await db.execute(sql`delete from incidents where server_name = 'offset-host'`);
    }
  });

  it('запись вида, которого в контракте нет, не сдвигает листание по смещению: её нет ни в строках, ни в общем числе', async () => {
    const db = app.get<Db>(DB);
    // Двенадцать решённых новее остальных дел этого набора; четвёртая — вида, которого в контракте уже нет.
    for (let i = 1; i <= 12; i += 1)
      await db.execute(
        sql`insert into incidents (server_name, kind, severity, status, title, opened_at, resolved_at, resolved_by)
            values ('legacy-host', ${i === 4 ? 'legacy_kind' : 'cpu_high'}, 'warn', 'resolved', ${`Сбой ${i} · legacy-host`}, now() + (${13 - i} || ' minutes')::interval, now(), 'auto')`,
      );
    try {
      const get = async (query: string) => {
        const res = incidentsListResponseSchema.parse(
          (await agent.get(`/api/incidents?${query}`).expect(200)).body,
        );
        return {
          ...res,
          mine: res.items
            .filter((i) => i.serverName === 'legacy-host')
            .map((i) => Number(/Сбой (\d+)/.exec(i.title)?.[1])),
        };
      };
      const all = await get('status=resolved&pageSize=100');
      expect(all.mine).toEqual([1, 2, 3, 5, 6, 7, 8, 9, 10, 11, 12]);
      // Общее число — по тем же строкам, что отдаются: клиент считает по нему диапазон и следующее смещение.
      expect(all.items.length).toBe(Math.min(all.total, 100));
      // Страница по смещению — ровно шесть строк; следующая начинается встык, без повтора и без пропуска.
      const first = await get('status=resolved&offset=0&pageSize=6');
      expect(first.mine).toEqual([1, 2, 3, 5, 6, 7]);
      expect(first.total).toBe(all.total);
      const second = await get('status=resolved&offset=6&pageSize=6');
      expect(second.mine).toEqual([8, 9, 10, 11, 12]);
      // «Все» режутся так же.
      const any = await get('status=all&pageSize=100');
      expect(any.items.length).toBe(Math.min(any.total, 100));
    } finally {
      await db.execute(sql`delete from incidents where server_name = 'legacy-host'`);
    }
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
    // .total, не .items.length: «решённые» теперь режутся постранично, а удаляются всегда все разом.
    expect(before.total).toBeGreaterThan(0);
    const res = await agent.delete('/api/incidents/resolved').set(CSRF_HEADER, csrf).expect(200);
    expect(res.body.deleted).toBe(before.total);
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

  it('настройки инцидентов: сохранение раздела не стирает режимы автопочинки и не снимает паузу', async () => {
    const policyNow = async () =>
      incidentPolicyResponseSchema.parse((await agent.get('/api/incidents/policy').expect(200)).body);
    const modes = (p: Awaited<ReturnType<typeof policyNow>>) =>
      Object.fromEntries(p.items.map((i) => [i.kind, i.policy]));
    // На странице «Автопочинка» выбраны режимы по сигналам и стоит пауза на время работ.
    await agent
      .patch('/api/incidents/policy')
      .set(CSRF_HEADER, csrf)
      .send({ autofixEnabled: true, policy: { node_down: 'auto', cpu_high: 'watch' }, pauseMinutes: 120 })
      .expect(200);
    const before = await policyNow();
    expect(before.pausedUntil).not.toBeNull();
    expect(modes(before)).toMatchObject({ node_down: 'auto', cpu_high: 'watch' });
    try {
      // В «Настройки → Инциденты» поменяли один порог: режимы и пауза остаются как были.
      const one = await agent
        .put('/api/settings/incidents')
        .set(CSRF_HEADER, csrf)
        .send({ memPct: 95 })
        .expect(200);
      expect(one.body.memPct).toBe(95);
      expect(one.body.policy).toMatchObject({ node_down: 'auto', cpu_high: 'watch' });
      expect(one.body.pausedUntil).toBe(before.pausedUntil);
      // Вкладка со страницей прежней версии присылает вместе с полями пустые режимы и «паузы нет» —
      // раздел их не принимает: они меняются только на странице «Автопочинка».
      const stale = await agent
        .put('/api/settings/incidents')
        .set(CSRF_HEADER, csrf)
        .send({
          forDurationMinutes: 5,
          cpuPct: 90,
          memPct: 90,
          diskPct: 85,
          autofixEnabled: true,
          autofixCooldownMinutes: 30,
          policy: {},
          pausedUntil: null,
        })
        .expect(200);
      expect(stale.body.memPct).toBe(90);
      expect(stale.body.policy).toMatchObject({ node_down: 'auto', cpu_high: 'watch' });
      expect(stale.body.pausedUntil).toBe(before.pausedUntil);
      const after = await policyNow();
      expect(after.autofixEnabled).toBe(true);
      expect(after.pausedUntil).toBe(before.pausedUntil);
      expect(modes(after)).toEqual(modes(before));
    } finally {
      await agent
        .patch('/api/incidents/policy')
        .set(CSRF_HEADER, csrf)
        .send({ autofixEnabled: false, policy: { node_down: 'ask', cpu_high: 'ask' }, pauseMinutes: 0 })
        .expect(200);
    }
  });
});
