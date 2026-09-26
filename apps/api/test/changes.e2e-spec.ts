import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import type { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import {
  type AssistantChange,
  assistantChangeSchema,
  assistantChatResponseSchema,
  CSRF_HEADER,
  incidentPolicyResponseSchema,
  providerSchema,
  type Server,
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
import {
  LLM_PROVIDER,
  type LlmProvider,
  type LlmResp,
  type LlmRunInput,
} from '../src/modules/assistant/llm.provider.js';
import { SetupService } from '../src/modules/auth/setup.service.js';
import { IncidentsRepository } from '../src/modules/incidents/incidents.repository.js';
import { FakeSsh, SSH_PASSWORD, SSH_USER } from './fake-ssh.js';

if (!process.env.DATABASE_URL?.endsWith('/nodeservice_test'))
  throw new Error('e2e: DATABASE_URL должен указывать на nodeservice_test');

const LOGIN = 'admin';
const PASSWORD = 'correct horse battery staple';

/** Чат по сценарию: в сообщении `CALLS=[{"name":"propose_change","input":{…}}]` — какие инструменты вызвать. */
class FakeLlm implements LlmProvider {
  /** Имена инструментов, которые были доступны модели в последнем обращении. */
  toolNames: string[] = [];
  async run(input: LlmRunInput): Promise<LlmResp> {
    this.toolNames = (input.tools ?? []).map((t) => t.name);
    const done = input.messages.some((m) => m.content.some((b) => b.type === 'tool_result'));
    const text = input.messages
      .flatMap((m) => m.content)
      .map((b) => (b.type === 'text' ? b.text : ''))
      .join(' ');
    if (!done) {
      const calls = JSON.parse(text.match(/CALLS=(\[.*\])/s)?.[1] ?? '[]') as Array<{
        name: string;
        input: Record<string, unknown>;
      }>;
      if (calls.length > 0)
        return {
          stopReason: 'tool_use',
          blocks: calls.map((c, i) => ({ type: 'tool_use' as const, id: `t${i}`, ...c })),
        };
    }
    const results = input.messages
      .flatMap((m) => m.content)
      .flatMap((b) => (b.type === 'tool_result' ? [b.content] : []));
    return {
      stopReason: 'end',
      blocks: [{ type: 'text', text: `Итог: ${results.join(' ¦ ').slice(0, 4000)}` }],
    };
  }
}

describe('изменения по предложению Джарвиса e2e (J5)', () => {
  let app: INestApplication;
  let agent: InstanceType<typeof TestAgent>;
  let csrf: string;
  let site: HttpServer;
  let srv: Server;
  const ssh = new FakeSsh();
  const fake = new FakeLlm();
  const provider: Record<string, string> = {};

  const chat = async (calls: unknown[]) =>
    assistantChatResponseSchema.parse(
      (
        await agent
          .post('/api/assistant/chat')
          .set(CSRF_HEADER, csrf)
          .send({ message: `Сделай. CALLS=${JSON.stringify(calls)}` })
          .expect(200)
      ).body,
    );
  const propose = async (operation: string, args: Record<string, unknown>): Promise<AssistantChange> => {
    const res = await chat([{ name: 'propose_change', input: { operation, args, reason: 'Так надо.' } }]);
    const card = res.message.proposals.find((p) => p.kind === 'change');
    if (card?.kind !== 'change') throw new Error(`карточки нет: ${res.message.content}`);
    return assistantChangeSchema.parse(
      (await agent.get(`/api/assistant/changes/${card.changeId}`).expect(200)).body,
    );
  };
  const act = (id: string, what: 'apply' | 'reject' | 'revert', status = 200) =>
    agent.post(`/api/assistant/changes/${id}/${what}`).set(CSRF_HEADER, csrf).expect(status);
  const serverNow = async () =>
    serverSchema.parse((await agent.get(`/api/servers/${srv.id}`).expect(200)).body);
  const auditActions = async () =>
    JSON.stringify((await agent.get('/api/audit?pageSize=100').expect(200)).body);
  const setPerms = (permissions: Record<string, boolean>) =>
    agent.put('/api/settings/assistant').set(CSRF_HEADER, csrf).send({ permissions }).expect(200);

  beforeAll(async () => {
    await ssh.start();
    site = createServer((_req, res) => {
      res.statusCode = 404;
      res.end();
    });
    await new Promise<void>((r) => site.listen(0, '127.0.0.1', () => r()));
    const siteUrl = `http://127.0.0.1:${(site.address() as AddressInfo).port}/`;
    process.env.PROVIDER_ICON_FALLBACK_URL = `${siteUrl}fallback/{host}`;

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(LLM_PROVIDER)
      .useValue(fake)
      .compile();
    app = moduleRef.createNestApplication<NestExpressApplication>({ bufferLogs: false, logger: false });
    setupHttp(app as NestExpressApplication);
    const db = app.get<Db>(DB);
    await runMigrations(db);
    await db.execute(
      sql`truncate users, recovery_codes, trusted_devices, setup_tokens, servers, incidents, providers, assistant_conversations cascade`,
    );
    await db.execute(sql`delete from app_meta where key like 'settings.%' or key = 'panel.ssh-key'`);
    await db.execute(sql`delete from kb_documents where title = 'Правила парка'`);
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
    await agent
      .put('/api/settings/assistant')
      .set(CSRF_HEADER, csrf)
      .send({ apiKey: 'sk-test-0123456789', model: 'anthropic/claude-sonnet-4-5' })
      .expect(200);
    for (const name of ['Hetzner', 'Aéza']) {
      const p = providerSchema.parse(
        (await agent.post('/api/providers').set(CSRF_HEADER, csrf).send({ name, siteUrl }).expect(201)).body,
      );
      provider[name] = p.id;
    }
    srv = serverSchema.parse(
      (
        await agent
          .post('/api/servers')
          .set(CSRF_HEADER, csrf)
          .send({
            name: 'ru-entry-1',
            host: '127.0.0.1',
            port: ssh.port,
            sshUser: SSH_USER,
            auth: { method: 'password', password: SSH_PASSWORD },
            tags: ['prod', 'de'],
            providerId: provider.Hetzner,
          })
          .expect(201)
      ).body,
    );
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    await ssh.stop();
    await new Promise<void>((r) => site.close(() => r()));
  });

  it('без входа изменения недоступны', async () => {
    const anon = request.agent(app.getHttpServer());
    const anonCsrf = (await anon.get('/api/auth/csrf').expect(200)).body.token as string;
    const id = '0192c000-0000-7000-8000-000000000001';
    await anon.get(`/api/assistant/changes/${id}`).expect(401);
    for (const what of ['apply', 'reject', 'revert'])
      await anon.post(`/api/assistant/changes/${id}/${what}`).set(CSRF_HEADER, anonCsrf).expect(401);
  });

  it('разрешение «Изменения по подтверждению» есть в настройках и включено по умолчанию; инструмент доступен модели', async () => {
    const status = (await agent.get('/api/assistant/status').expect(200)).body;
    expect(status.permissions.changes).toBe(true);
    await chat([]);
    expect(fake.toolNames).toContain('propose_change');
  });

  it('карточка провайдера: предложение ничего не меняет, применение меняет и пишет в Журнал, откат возвращает', async () => {
    const c = await propose('server.provider', { server: 'ru-entry-1', provider: 'aéza' });
    expect(c).toMatchObject({
      status: 'proposed',
      level: 'T1',
      reversible: true,
      target: { type: 'server', label: 'ru-entry-1' },
      rows: [{ label: 'Провайдер', before: 'Hetzner', after: 'Aéza' }],
    });
    expect((await serverNow()).providerId).toBe(provider.Hetzner);

    const applied = assistantChangeSchema.parse((await act(c.id, 'apply')).body);
    expect(applied).toMatchObject({ status: 'applied', decidedBy: LOGIN });
    expect(applied.note).toContain('Проверено');
    expect((await serverNow()).providerId).toBe(provider.Aéza);
    const audit = await auditActions();
    expect(audit).toContain('assistant.change.applied');
    expect(audit).toContain('server.updated');

    // Повторное нажатие не применяет второй раз
    expect(assistantChangeSchema.parse((await act(c.id, 'apply')).body).status).toBe('applied');

    const back = assistantChangeSchema.parse((await act(c.id, 'revert')).body);
    expect(back.status).toBe('reverted');
    expect((await serverNow()).providerId).toBe(provider.Hetzner);
    expect(await auditActions()).toContain('assistant.change.reverted');
  });

  it('состояние изменилось после предложения: применение отказывает и ничего не трогает', async () => {
    const c = await propose('server.notes', { server: 'ru-entry-1', notes: 'Заметка Джарвиса' });
    await agent
      .patch(`/api/servers/${srv.id}`)
      .set(CSRF_HEADER, csrf)
      .send({ notes: 'Поправил сам' })
      .expect(200);
    const r = assistantChangeSchema.parse((await act(c.id, 'apply')).body);
    expect(r.status).toBe('stale');
    expect(r.note).toContain('Состояние изменилось');
    expect((await serverNow()).notes).toBe('Поправил сам');
    await act(c.id, 'apply', 409);
  });

  it('отклонение; отклонённое применить нельзя', async () => {
    const c = await propose('server.tags', { server: 'ru-entry-1', add: ['vip'], remove: ['de'] });
    expect(c.rows[0]).toMatchObject({
      before: 'prod, de',
      after: 'prod, vip',
      added: ['vip'],
      removed: ['de'],
    });
    expect(assistantChangeSchema.parse((await act(c.id, 'reject')).body).status).toBe('rejected');
    await act(c.id, 'apply', 409);
    expect((await serverNow()).tags).toEqual(['prod', 'de']);
    expect(await auditActions()).toContain('assistant.change.rejected');
  });

  it('профиль и слежение за нодой: применение, расхождения считаются панелью, откат', async () => {
    const c = await propose('server.profile', {
      server: 'ru-entry-1',
      roles: ['exit', 'entry'],
      importance: 'critical',
      expectedContainers: ['remnanode'],
      expectedPorts: [443],
    });
    await act(c.id, 'apply');
    const s = await serverNow();
    expect(s.profile).toMatchObject({
      roles: ['entry', 'exit'],
      importance: 'critical',
      expectedContainers: ['remnanode'],
    });
    await act(c.id, 'revert');
    expect((await serverNow()).profile).toMatchObject({
      roles: [],
      importance: 'normal',
      expectedContainers: [],
    });

    const w = await propose('server.nodeWatch', { server: 'ru-entry-1', mode: 'off' });
    expect(w.consequence).toContain('перестанет следить');
    await act(w.id, 'apply');
    expect((await serverNow()).nodeWatch).toBe('off');
    await act(w.id, 'revert');
    expect((await serverNow()).nodeWatch).toBe('auto');
  });

  it('переименование: карточка, применение и откат возвращают имя', async () => {
    const c = await propose('server.rename', { server: 'ru-entry-1', name: 'ru-entry-9' });
    await act(c.id, 'apply');
    expect((await serverNow()).name).toBe('ru-entry-9');
    await act(c.id, 'revert');
    expect((await serverNow()).name).toBe('ru-entry-1');
  });

  it('закрытие инцидента: применяется и пишется в Журнал, но кнопкой не отменяется', async () => {
    const row = await app.get(IncidentsRepository).open({
      serverId: srv.id,
      serverName: srv.name,
      kind: 'disk_high',
      severity: 'warn',
      title: 'Диск заполняется',
      detail: 'Диск выше порога.',
      timeline: [{ at: new Date().toISOString(), by: 'auto', action: 'Обнаружено', result: 'detect' }],
    });
    const c = await propose('incident.resolve', { incidentId: row?.id });
    expect(c).toMatchObject({ level: 'T2', reversible: false, target: { type: 'incident' } });
    await act(c.id, 'apply');
    const inc = (await agent.get(`/api/incidents/${row?.id}`).expect(200)).body;
    expect(inc.status).toBe('resolved');
    await act(c.id, 'revert', 409);
    // Закрытый инцидент повторно не предлагается
    const res = await chat([
      {
        name: 'propose_change',
        input: { operation: 'incident.resolve', args: { incidentId: row?.id }, reason: 'x' },
      },
    ]);
    expect(res.message.proposals).toEqual([]);
    expect(res.message.content).toContain('уже закрыт');
  });

  it('пауза автопочинки: при выключенной отказ, при включённой ставится и снимается откатом', async () => {
    const off = await chat([
      { name: 'propose_change', input: { operation: 'autofix.pause', args: { minutes: 30 }, reason: 'x' } },
    ]);
    expect(off.message.proposals).toEqual([]);
    expect(off.message.content).toContain('выключена');

    await agent
      .patch('/api/incidents/policy')
      .set(CSRF_HEADER, csrf)
      .send({ autofixEnabled: true })
      .expect(200);
    const c = await propose('autofix.pause', { minutes: 30 });
    await act(c.id, 'apply');
    const paused = incidentPolicyResponseSchema.parse(
      (await agent.get('/api/incidents/policy').expect(200)).body,
    );
    expect(paused.pausedUntil).not.toBeNull();
    await act(c.id, 'revert');
    expect(
      incidentPolicyResponseSchema.parse((await agent.get('/api/incidents/policy').expect(200)).body)
        .pausedUntil,
    ).toBeNull();
    await agent
      .patch('/api/incidents/policy')
      .set(CSRF_HEADER, csrf)
      .send({ autofixEnabled: false })
      .expect(200);
  });

  it('за один ответ не больше трёх карточек, чужие операции и негодные аргументы карточки не дают', async () => {
    const note = (n: number) => ({
      name: 'propose_change',
      input: {
        operation: 'server.notes',
        args: { server: 'ru-entry-1', notes: `Заметка ${n}` },
        reason: 'x',
      },
    });
    const res = await chat([note(1), note(2), note(3), note(4)]);
    expect(res.message.proposals.filter((p) => p.kind === 'change')).toHaveLength(3);
    expect(res.message.content).toContain('не больше 3');

    const bad = await chat([
      {
        name: 'propose_change',
        input: { operation: 'server.delete', args: { server: 'ru-entry-1' }, reason: 'x' },
      },
      {
        name: 'propose_change',
        input: { operation: 'server.rename', args: { server: 'нет-такого', name: 'q' }, reason: 'x' },
      },
    ]);
    expect(bad.message.proposals).toEqual([]);
    expect(bad.message.content).toContain('Доступные:');
    expect((await serverNow()).name).toBe('ru-entry-1');
  });

  it('вкладка «Профиль» сохраняет слежение за нодой и профиль одним запросом', async () => {
    const res = await agent
      .patch(`/api/servers/${srv.id}`)
      .set(CSRF_HEADER, csrf)
      .send({ nodeWatch: 'on', profile: { roles: ['bridge', 'entry'], importance: 'low' } })
      .expect(200);
    const s = serverSchema.parse(res.body);
    expect(s.nodeWatch).toBe('on');
    expect(s.profile).toMatchObject({ roles: ['entry', 'bridge'], importance: 'low' });
    await agent
      .patch(`/api/servers/${srv.id}`)
      .set(CSRF_HEADER, csrf)
      .send({ nodeWatch: 'auto', profile: { roles: [], importance: 'normal' } })
      .expect(200);
  });

  it('режим автопочинки по виду инцидента: «Само» это T2, применяется, виден в политике и откатывается', async () => {
    const policyOf = async (kind: string) =>
      incidentPolicyResponseSchema
        .parse((await agent.get('/api/incidents/policy').expect(200)).body)
        .items.find((i) => i.kind === kind)?.policy;
    const c = await propose('autofix.policy', { kind: 'disk_high', policy: 'auto' });
    expect(c).toMatchObject({ level: 'T2', reversible: true, target: { type: 'settings' } });
    expect(await policyOf('disk_high')).toBe('ask');
    await act(c.id, 'apply');
    expect(await policyOf('disk_high')).toBe('auto');
    await act(c.id, 'revert');
    expect(await policyOf('disk_high')).toBe('ask');
    const no = await chat([
      {
        name: 'propose_change',
        input: { operation: 'autofix.policy', args: { kind: 'ssh_down', policy: 'auto' }, reason: 'x' },
      },
    ]);
    expect(no.message.proposals).toEqual([]);
    expect(no.message.content).toContain('нет безопасного шага');
  });

  it('обслуживание: проверка запускается по карточке, ход виден в карточке, остальные действия ждут данных проверки', async () => {
    const waitIdle = async () => {
      for (let i = 0; i < 100; i += 1) {
        const st = (await agent.get(`/api/servers/${srv.id}/maintenance`).expect(200)).body;
        if (!st.running) return st;
        await new Promise((r) => setTimeout(r, 50));
      }
      throw new Error('обслуживание не завершилось');
    };
    // До первой проверки очистка и автообновления не предлагаются
    const early = await chat([
      {
        name: 'propose_change',
        input: { operation: 'maintenance.run', args: { server: 'ru-entry-1', kind: 'cleanup' }, reason: 'x' },
      },
    ]);
    expect(early.message.proposals).toEqual([]);
    expect(early.message.content).toContain('операцию «check»');

    const c = await propose('maintenance.run', { server: 'ru-entry-1', kind: 'check' });
    expect(c).toMatchObject({ level: 'T0', reversible: false, title: 'Проверить сервер' });
    const applied = assistantChangeSchema.parse((await act(c.id, 'apply')).body);
    expect(applied.status).toBe('applied');
    expect(applied.note).toContain('Проверить сервер');
    await waitIdle();
    const after = assistantChangeSchema.parse(
      (await agent.get(`/api/assistant/changes/${c.id}`).expect(200)).body,
    );
    expect(after).toMatchObject({ status: 'applied', live: false });
    expect(after.note).toContain('готово');
    expect(await auditActions()).toContain('server.maintenance.check');
    await act(c.id, 'revert', 409);

    // Теперь есть данные: диск занят на 16 %, чистить нечего; агент уже нужной версии или последняя неизвестна
    const clean = await chat([
      {
        name: 'propose_change',
        input: { operation: 'maintenance.run', args: { server: 'ru-entry-1', kind: 'cleanup' }, reason: 'x' },
      },
    ]);
    expect(clean.message.proposals).toEqual([]);
    expect(clean.message.content).toContain('чистить нечего');

    const u = await propose('maintenance.run', { server: 'ru-entry-1', kind: 'unattended_enable' });
    expect(u).toMatchObject({ level: 'T2', rows: [{ before: 'Выключены', after: 'Включены' }] });
    await act(u.id, 'apply');
    await waitIdle();
    const uAfter = assistantChangeSchema.parse(
      (await agent.get(`/api/assistant/changes/${u.id}`).expect(200)).body,
    );
    expect(uAfter.live).toBe(false);
    expect(uAfter.note).toMatch(/готово|ошибка/);
  });

  it('просроченное предложение не применяется', async () => {
    const c = await propose('server.notes', { server: 'ru-entry-1', notes: 'Устареет' });
    const db = app.get<Db>(DB);
    await db.execute(
      sql`update assistant_changes set expires_at = now() - interval '1 minute' where id = ${c.id}`,
    );
    expect(assistantChangeSchema.parse((await act(c.id, 'apply')).body).status).toBe('expired');
    expect((await serverNow()).notes).not.toBe('Устареет');
  });

  it('сводка и выключенное разрешение: карточек нет, инструмент модели не показывается', async () => {
    const sum = (await agent.get('/api/assistant/changes/summary?days=7').expect(200)).body;
    expect(sum.applied + sum.reverted).toBeGreaterThanOrEqual(6);
    expect(sum.reverted).toBeGreaterThanOrEqual(4);
    expect(sum.rejected).toBeGreaterThanOrEqual(1);

    await setPerms({ changes: false });
    const res = await chat([
      {
        name: 'propose_change',
        input: { operation: 'server.notes', args: { server: 'ru-entry-1', notes: 'Нельзя' }, reason: 'x' },
      },
    ]);
    expect(fake.toolNames).not.toContain('propose_change');
    expect(res.message.proposals).toEqual([]);
    expect(res.message.content).toContain('выключены в разрешениях');
    await setPerms({ changes: true });
  });

  it('несуществующее изменение — 404, неверный id — 400', async () => {
    await agent.get('/api/assistant/changes/0192c000-0000-7000-8000-00000000ffff').expect(404);
    await agent.get('/api/assistant/changes/не-uuid').expect(400);
  });
});
