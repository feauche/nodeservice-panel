import type { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import {
  assistantChatResponseSchema,
  CSRF_HEADER,
  incidentSchema,
  type Server,
  serverSchema,
  terminalHintResponseSchema,
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
import { FleetProbeService } from '../src/modules/assistant/fleet-probe.service.js';
import { IncidentAnalysisService } from '../src/modules/assistant/incident-analysis.service.js';
import {
  LLM_PROVIDER,
  type LlmProvider,
  type LlmResp,
  type LlmRunInput,
} from '../src/modules/assistant/llm.provider.js';
import { SetupService } from '../src/modules/auth/setup.service.js';
import { IncidentsRepository } from '../src/modules/incidents/incidents.repository.js';
import { ServersService } from '../src/modules/servers/servers.service.js';
import { FakeSsh, SSH_PASSWORD, SSH_USER } from './fake-ssh.js';

if (!process.env.DATABASE_URL?.endsWith('/nodeservice_test'))
  throw new Error('e2e: DATABASE_URL должен указывать на nodeservice_test');

const LOGIN = 'admin';
const PASSWORD = 'correct horse battery staple';

/** Чат: по маркеру просит карточки; смотрит, что вернули инструменты. */
class FakeLlm implements LlmProvider {
  preset = 'tmp_clean';
  /** Что ушло модели в подсказках к терминалу: проверяем, что секреты замаскированы. */
  hintInputs: string[] = [];
  async run(input: LlmRunInput): Promise<LlmResp> {
    const done = input.messages.some((m) => m.content.some((b) => b.type === 'tool_result'));
    const text = input.messages
      .flatMap((m) => m.content)
      .map((b) => (b.type === 'text' ? b.text : ''))
      .join(' ');
    if (input.system.startsWith('ПОДСКАЗКА К ТЕРМИНАЛУ.')) {
      if (done) return { stopReason: 'end', blocks: [{ type: 'text', text: 'готово' }] };
      this.hintInputs.push(text);
      return {
        stopReason: 'tool_use',
        blocks: [
          {
            type: 'tool_use',
            id: 'h1',
            name: 'submit_hint',
            input: {
              title: 'Упёрся conntrack',
              explanation: 'Таблица соединений переполнена.',
              commands: [
                { command: 'rm -rf /', note: 'опасно' },
                { command: 'ss -s', note: 'сводка' },
                { command: 'sysctl -w net.netfilter.nf_conntrack_max=1048576', note: 'поднять лимит' },
              ],
            },
          },
        ],
      };
    }
    if (input.system.startsWith('РАЗБОР ИНЦИДЕНТА.')) {
      if (!done)
        return {
          stopReason: 'tool_use',
          blocks: [
            {
              type: 'tool_use',
              id: 'a1',
              name: 'check_reachability',
              input: { serverId: 'цель', ports: [22] },
            },
          ],
        };
      return {
        stopReason: 'tool_use',
        blocks: [
          {
            type: 'tool_use',
            id: 'a2',
            name: 'submit_analysis',
            input: {
              verdict: 'Порт SSH открыт со всех проверяющих.',
              confidence: 'medium',
              evidence: [{ source: 'other', text: 'Проверка доступности прошла.' }],
            },
          },
        ],
      };
    }
    if (text.includes('ДОСТУПНОСТЬ')) {
      if (done) return { stopReason: 'end', blocks: [{ type: 'text', text: 'Проверил.' }] };
      return {
        stopReason: 'tool_use',
        blocks: [
          {
            type: 'tool_use',
            id: 'c1',
            name: 'check_reachability',
            input: { serverId: 'цель', ports: [22, 443] },
          },
        ],
      };
    }
    if (!done) {
      const id = text.match(/incident=([0-9a-f-]{36})/)?.[1] ?? '';
      return {
        stopReason: 'tool_use',
        blocks: [
          {
            type: 'tool_use',
            id: 'p1',
            name: 'propose_action',
            input: {
              incidentId: id,
              preset: this.preset,
              reason: 'Осмотр показал временные файлы.',
              title: 'Подмена названия',
            },
          },
          {
            type: 'tool_use',
            id: 'p2',
            name: 'propose_action',
            input: { incidentId: id, preset: this.preset, reason: 'Повтор той же карточки.' },
          },
          { type: 'tool_use', id: 'p3', name: 'get_playbook', input: { id: 'disk_full' } },
        ],
      };
    }
    const results = input.messages
      .flatMap((m) => m.content)
      .flatMap((b) => (b.type === 'tool_result' ? [b.content] : []));
    return {
      stopReason: 'end',
      blocks: [{ type: 'text', text: `Итог: ${results.join(' ¦ ').slice(0, 400)}` }],
    };
  }
}

describe('проверка доступности, процессы и предложения e2e', () => {
  let app: INestApplication;
  let agent: InstanceType<typeof TestAgent>;
  let csrf: string;
  const ssh = new FakeSsh();
  const fake = new FakeLlm();
  const created: Server[] = [];

  const addServer = async (name: string) => {
    const res = await agent
      .post('/api/servers')
      .set(CSRF_HEADER, csrf)
      .send({
        name,
        host: '127.0.0.1',
        port: ssh.port,
        sshUser: SSH_USER,
        auth: { method: 'password', password: SSH_PASSWORD },
      })
      .expect(201);
    const srv = serverSchema.parse(res.body);
    const db = app.get<Db>(DB);
    for (let i = 0; i < 60; i += 1) {
      const r = await db.execute<{ agent_status: string }>(
        sql`select agent_status from servers where id = ${srv.id}`,
      );
      if (r.rows[0]?.agent_status === 'pending') break;
      await new Promise((res2) => setTimeout(res2, 100));
    }
    created.push(srv);
    return srv;
  };
  const all = () => app.get(ServersService).list();
  const target = () => created[0] as Server;

  beforeAll(async () => {
    await ssh.start();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(LLM_PROVIDER)
      .useValue(fake)
      .compile();
    app = moduleRef.createNestApplication<NestExpressApplication>({ bufferLogs: false, logger: false });
    setupHttp(app as NestExpressApplication);
    const db = app.get<Db>(DB);
    await runMigrations(db);
    await db.execute(
      sql`truncate users, recovery_codes, trusted_devices, setup_tokens, servers, incidents, assistant_conversations cascade`,
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
    await agent
      .put('/api/settings/assistant')
      .set(CSRF_HEADER, csrf)
      .send({ apiKey: 'sk-test-0123456789', model: 'anthropic/claude-sonnet-4-5' })
      .expect(200);
    for (const n of ['цель', 'проверка-а', 'проверка-б', 'проверка-в']) await addServer(n);
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    await ssh.stop();
  });

  it('доступность: открыт со всех, закрыт со всех, частично; сам сервер не проверяет себя', async () => {
    const probe = app.get(FleetProbeService);
    ssh.reachQueue = ['open', 'open', 'open'];
    let r = await probe.reachability(target(), await all(), [22]);
    expect(r.probes.map((p) => p.from).sort()).toEqual(['проверка-а', 'проверка-б', 'проверка-в']);
    expect(r.ports[0]?.verdict).toBe('reachable');
    expect(r.dns).toEqual({ answers: ['203.0.113.7'], consistent: true });
    expect(r.notes.join(' ')).toContain('не из сети пользователей');

    ssh.reachQueue = ['closed', 'closed', 'closed'];
    r = await probe.reachability(target(), await all(), [22, 443]);
    expect(r.ports.map((p) => p.verdict)).toEqual(['closed_everywhere', 'closed_everywhere']);

    ssh.reachQueue = ['open', 'closed', 'open'];
    r = await probe.reachability(target(), await all(), [443]);
    expect(r.ports[0]).toMatchObject({ verdict: 'partial', open: 2, closed: 1 });
    // На проверяющих выполнялась именно проверка доступности и ничего больше
    const cmds = ssh.execLog.filter((c) => c.includes('ns-reach'));
    expect(cmds.length).toBeGreaterThanOrEqual(9);
    for (const c of cmds) expect(c).not.toMatch(/rm |reboot|systemctl|docker /);
  });

  it('проверяющие без рабочего SSH не берутся; меньше двух — предупреждение; ни одного — честное «не с чего»', async () => {
    const probe = app.get(FleetProbeService);
    const db = app.get<Db>(DB);
    await db.execute(sql`update servers set ssh_ok = false where name in ('проверка-б', 'проверка-в')`);
    ssh.reachQueue = ['open'];
    let r = await probe.reachability(target(), await all(), [22]);
    expect(r.probes.map((p) => p.from)).toEqual(['проверка-а']);
    expect(r.notes.join(' ')).toContain('меньше двух');
    await db.execute(sql`update servers set ssh_ok = false where name = 'проверка-а'`);
    r = await probe.reachability(target(), await all(), [22]);
    expect(r.probes).toEqual([]);
    expect(r.notes.join(' ')).toContain('проверить снаружи не с чего');
    await db.execute(sql`update servers set ssh_ok = true`);
  });

  it('процессы: имена и проценты, load; сервер без SSH — сообщение, а не падение', async () => {
    const r = await app.get(FleetProbeService).processes(target().id);
    expect(r.cpu[0]).toMatchObject({ name: 'xray', cpu: 87.5 });
    expect(r.load).toBe('4.20 3.90 2.10');
    expect(ssh.execLog.some((c) => c.includes('comm=') && !/args|aux/.test(c))).toBe(true);
  });

  it('чат: карточка только по существующему инциденту из цепочки, название из реестра, повтор не дублируется', async () => {
    const db = app.get<Db>(DB);
    await db.execute(sql`delete from incidents`);
    const row = await app.get(IncidentsRepository).open({
      serverId: target().id,
      serverName: target().name,
      kind: 'disk_high',
      severity: 'warn',
      title: 'Диск заполняется',
      detail: 'Диск выше порога.',
      timeline: [{ at: new Date().toISOString(), by: 'auto', action: 'Обнаружено', result: 'detect' }],
    });
    const id = row?.id ?? '';
    fake.preset = 'tmp_clean';
    const res = assistantChatResponseSchema.parse(
      (
        await agent
          .post('/api/assistant/chat')
          .set(CSRF_HEADER, csrf)
          .send({ message: `Что делать? incident=${id}` })
          .expect(200)
      ).body,
    );
    expect(res.message.proposals).toHaveLength(1);
    expect(res.message.proposals[0]).toMatchObject({
      preset: 'tmp_clean',
      level: 'T2',
      title: 'Очистить временные файлы',
      incidentId: id,
    });
    expect(res.message.content).toContain('Карточка «Очистить временные файлы» (T2)');
    expect(res.message.content).toContain('ПЛЕЙБУК «Диск заполнен»');

    // T3 карточкой не предлагается
    fake.preset = 'reboot';
    const t3 = assistantChatResponseSchema.parse(
      (
        await agent
          .post('/api/assistant/chat')
          .set(CSRF_HEADER, csrf)
          .send({ message: `Перезагрузить? incident=${id}` })
          .expect(200)
      ).body,
    );
    expect(t3.message.proposals).toHaveLength(0);
    // reboot не из цепочки disk_high → «нет в цепочке»
    expect(t3.message.content).toContain('нет в цепочке');
  });
  it('чат: проверка доступности возвращается структурой и сохраняется в сообщении', async () => {
    ssh.reachQueue = ['open', 'open', 'open'];
    const res = assistantChatResponseSchema.parse(
      (
        await agent
          .post('/api/assistant/chat')
          .set(CSRF_HEADER, csrf)
          .send({ message: 'ДОСТУПНОСТЬ цели?' })
          .expect(200)
      ).body,
    );
    expect(res.message.reachability).toHaveLength(1);
    const r = res.message.reachability[0];
    expect(r?.target.name).toBe('цель');
    expect(r?.probes).toHaveLength(3);
    expect(r?.ports.map((p) => p.verdict)).toEqual(['reachable', 'reachable']);
    const history = await agent.get(`/api/assistant/conversations/${res.conversationId}`).expect(200);
    expect(JSON.stringify(history.body)).toContain('"reachability"');
    expect(JSON.stringify(history.body)).toContain('reachable');
  });

  it('разбор инцидента сохраняет проверку доступности вместе с выводом', async () => {
    const db = app.get<Db>(DB);
    await db.execute(sql`delete from incidents`);
    const row = await app.get(IncidentsRepository).open({
      serverId: target().id,
      serverName: target().name,
      kind: 'ssh_down',
      severity: 'crit',
      title: 'SSH недоступен',
      detail: 'Сервер не отвечает.',
      timeline: [{ at: new Date().toISOString(), by: 'auto', action: 'Обнаружено', result: 'detect' }],
    });
    const id = row?.id ?? '';
    ssh.reachQueue = ['open', 'open', 'open'];
    await agent.post(`/api/incidents/${id}/analysis`).set(CSRF_HEADER, csrf).expect(202);
    for (let i = 0; i < 100; i += 1) {
      const inc = incidentSchema.parse((await agent.get(`/api/incidents/${id}`).expect(200)).body);
      if (inc.analysis && inc.analysis.status !== 'running') {
        expect(inc.analysis.status).toBe('done');
        expect(inc.analysis.reachability?.ports[0]?.verdict).toBe('reachable');
        expect(inc.analysis.reachability?.probes).toHaveLength(3);
        return;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error('разбор не завершился');
  });

  it('подсказка к терминалу: секреты маскируются до модели, опасные команды убираются, вывод в Журнал не пишется', async () => {
    const out = [
      'root@de-1:~# cat /opt/app/.env',
      'DB_PASSWORD=hunter2-very-secret',
      'user 203.0.113.77 connected',
      '-----BEGIN OPENSSH PRIVATE KEY-----',
      'AAAAB3NzaC1yc2EAAAADAQABAAABAQC',
      '-----END OPENSSH PRIVATE KEY-----',
      '[812345.6] nf_conntrack: table full, dropping packet',
    ].join('\n');
    const res = await agent
      .post(`/api/servers/${target().id}/terminal/hint`)
      .set(CSRF_HEADER, csrf)
      .send({ text: out, question: 'Что это?' })
      .expect(200);
    const body = terminalHintResponseSchema.parse(res.body);
    expect(body.title).toBe('Упёрся conntrack');
    expect(body.commands.map((c) => [c.command, c.risk])).toEqual([
      ['ss -s', 'read'],
      ['sysctl -w net.netfilter.nf_conntrack_max=1048576', 'change'],
    ]);
    expect(body.masked).toBeGreaterThanOrEqual(3);
    const sent = fake.hintInputs.at(-1) ?? '';
    expect(sent).toContain('nf_conntrack: table full');
    expect(sent).toContain('Что это?');
    expect(sent).toContain('<вывод>');
    for (const secret of ['hunter2', '203.0.113.77', 'AAAAB3NzaC1yc2E', 'PRIVATE KEY'])
      expect(sent, secret).not.toContain(secret);
    const audit = await agent.get('/api/audit?category=server').expect(200);
    expect(JSON.stringify(audit.body)).toContain('server.terminal.hint');
    expect(JSON.stringify(audit.body)).not.toContain('hunter2');
    expect(JSON.stringify(audit.body)).not.toContain('nf_conntrack: table full');
  });

  it('подсказка: пустой вывод, чужой сервер, лишний размер и выключенный Джарвис', async () => {
    const hint = (id: string, body: object) =>
      agent.post(`/api/servers/${id}/terminal/hint`).set(CSRF_HEADER, csrf).send(body);
    await hint(target().id, { text: '   \n  ' }).expect(400);
    await hint('0192c000-0000-7000-8000-0000000000ff', { text: 'x' }).expect(404);
    await hint(target().id, { text: 'x'.repeat(12_001) }).expect(400);
    await agent.put('/api/settings/assistant').set(CSRF_HEADER, csrf).send({ clearKey: true }).expect(200);
    await hint(target().id, { text: 'x' }).expect(409);
    await agent
      .put('/api/settings/assistant')
      .set(CSRF_HEADER, csrf)
      .send({ apiKey: 'sk-test-0123456789', model: 'anthropic/claude-sonnet-4-5' })
      .expect(200);
  });

  describe('разрешения Джарвиса', () => {
    const setPerms = (permissions: Record<string, boolean>) =>
      agent.put('/api/settings/assistant').set(CSRF_HEADER, csrf).send({ permissions }).expect(200);
    const openIncident = async (ageMs: number) => {
      const db = app.get<Db>(DB);
      await db.execute(sql`delete from incidents`);
      const row = await app.get(IncidentsRepository).open({
        serverId: target().id,
        serverName: target().name,
        kind: 'ssh_down',
        severity: 'crit',
        title: 'SSH недоступен',
        detail: 'Сервер не отвечает.',
        timeline: [{ at: new Date().toISOString(), by: 'auto', action: 'Обнаружено', result: 'detect' }],
      });
      const id = row?.id ?? '';
      await db.execute(
        sql`update incidents set opened_at = now() - (${ageMs} * interval '1 millisecond') where id = ${id}`,
      );
      return id;
    };
    const waitDone = async (id: string) => {
      for (let i = 0; i < 100; i += 1) {
        const inc = incidentSchema.parse((await agent.get(`/api/incidents/${id}`).expect(200)).body);
        if (inc.analysis && inc.analysis.status !== 'running') return inc;
        await new Promise((r) => setTimeout(r, 50));
      }
      throw new Error('разбор не завершился');
    };

    it('без «Проверки доступности снаружи» чат не ходит на серверы и говорит об этом', async () => {
      await setPerms({ reach: false });
      ssh.execLog.length = 0;
      const res = assistantChatResponseSchema.parse(
        (
          await agent
            .post('/api/assistant/chat')
            .set(CSRF_HEADER, csrf)
            .send({ message: 'ДОСТУПНОСТЬ цели?' })
            .expect(200)
        ).body,
      );
      expect(res.message.reachability).toHaveLength(0);
      expect(ssh.execLog.filter((c) => c.includes('ns-reach'))).toHaveLength(0);
      await setPerms({ reach: true });
    });

    it('без «Разбора по кнопке» запуск и вопрос по разбору отклоняются с понятным текстом', async () => {
      const id = await openIncident(5 * 60_000);
      await setPerms({ analysis: false });
      const run = await agent.post(`/api/incidents/${id}/analysis`).set(CSRF_HEADER, csrf).expect(409);
      expect(JSON.stringify(run.body)).toContain('Разбор по кнопке');
      await agent
        .post(`/api/incidents/${id}/analysis/ask`)
        .set(CSRF_HEADER, csrf)
        .send({ question: 'Почему?' })
        .expect(409);
      await setPerms({ analysis: true });
    });

    it('автоматический разбор: выключен по умолчанию, включённый берёт только инцидент старше паузы, один раз', async () => {
      const analysis = app.get(IncidentAnalysisService);
      const id = await openIncident(5 * 60_000);
      expect(await analysis.autoRun()).toEqual([]);
      await setPerms({ autoAnalysis: true });
      const fresh = await openIncident(10_000);
      expect(await analysis.autoRun()).toEqual([]);
      expect(fresh).not.toBe('');
      const old = await openIncident(5 * 60_000);
      expect(await analysis.autoRun()).toEqual([old]);
      const done = await waitDone(old);
      expect(done.analysis?.status).toBe('done');
      expect(await analysis.autoRun()).toEqual([]);
      expect(id).not.toBe('');
      const audit = await agent.get('/api/audit?category=server').expect(200);
      expect(JSON.stringify(audit.body)).toContain('incident.analysis.run');
      await setPerms({ autoAnalysis: false });
    });

    it('без «Разбора по кнопке» автоматический разбор тоже не идёт', async () => {
      const analysis = app.get(IncidentAnalysisService);
      await setPerms({ autoAnalysis: true, analysis: false });
      await openIncident(5 * 60_000);
      expect(await analysis.autoRun()).toEqual([]);
      await setPerms({ autoAnalysis: false, analysis: true });
    });

    it('без «Подсказок в терминале» подсказка отклоняется, а данные модели не уходят', async () => {
      const before = fake.hintInputs.length;
      await setPerms({ terminalHints: false });
      const res = await agent
        .post(`/api/servers/${target().id}/terminal/hint`)
        .set(CSRF_HEADER, csrf)
        .send({ text: 'ss -s' })
        .expect(409);
      expect(JSON.stringify(res.body)).toContain('Подсказки в терминале выключены');
      expect(fake.hintInputs).toHaveLength(before);
      await setPerms({ terminalHints: true });
    });
  });
});
