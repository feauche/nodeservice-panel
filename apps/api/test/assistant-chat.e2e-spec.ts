import type { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { assistantChatResponseSchema, CSRF_HEADER } from '@nodeservice/shared';
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

if (!process.env.DATABASE_URL?.endsWith('/nodeservice_test'))
  throw new Error('e2e: DATABASE_URL должен указывать на nodeservice_test');

const LOGIN = 'admin';
const PASSWORD = 'correct horse battery staple';

const text = (t: string): LlmResp => ({ stopReason: 'end', blocks: [{ type: 'text', text: t }] });
const tool = (name: string, input: unknown = {}, say = ''): LlmResp => ({
  stopReason: 'tool_use',
  blocks: [
    ...(say ? [{ type: 'text' as const, text: say }] : []),
    { type: 'tool_use', id: `t-${name}`, name, input },
  ],
});

/** Сценарии сбоев чата: пустой ответ, обещание без вызова, бесконечные вызовы, несколько сообщений. */
class FakeLlm implements LlmProvider {
  script = '';
  calls: LlmRunInput[] = [];
  async run(input: LlmRunInput): Promise<LlmResp> {
    this.calls.push(input);
    const n = this.calls.filter((c) => c.messages[0]?.content[0]).length;
    const user = input.messages[0]?.content[0];
    void user;
    const step = this.calls.length; // 1-й, 2-й… вызов в рамках сценария (calls чистится тестом)
    const done = input.messages.some((m) => m.content.some((b) => b.type === 'tool_result'));
    void n;
    switch (this.script) {
      case 'empty':
        return step === 1 ? { stopReason: 'end', blocks: [] } : text('Ответ после толчка.');
      case 'promise':
        if (step === 1)
          return text(
            'Причина: нужно было вызвать list_incidents. Сейчас вызываю инструмент, чтобы дать ответ.',
          );
        if (!done) return tool('list_incidents', { status: 'all' });
        return text('На ru-bridge больше всего инцидентов.');
      case 'loop':
        // Всегда просит инструмент, пока инструменты есть; без инструментов даёт итог.
        return input.tools.length > 0 ? tool('get_settings') : text('Итог без инструментов.');
      case 'multi':
        if (!done) return tool('list_incidents', {}, 'Смотрю данные по инцидентам.');
        return text('Вывод: всё в порядке.\n===\nИнструкция: ничего делать не нужно.\n===\nКоманда: uptime');
      case 'stopped-with-calls':
        // Провайдер вернул вызов, но с «остановкой»: вызов не должен потеряться.
        return step === 1
          ? { stopReason: 'end', blocks: [{ type: 'tool_use', id: 'x', name: 'get_settings', input: {} }] }
          : text('Настройки прочитаны.');
      default:
        return text('ok');
    }
  }
}

describe('чат ассистента: устойчивость e2e', () => {
  let app: INestApplication;
  let agent: InstanceType<typeof TestAgent>;
  let csrf: string;
  const fake = new FakeLlm();

  const ask = async (script: string, message = 'Вопрос') => {
    fake.script = script;
    fake.calls = [];
    return assistantChatResponseSchema.parse(
      (await agent.post('/api/assistant/chat').set(CSRF_HEADER, csrf).send({ message }).expect(200)).body,
    );
  };

  beforeAll(async () => {
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
    // Два сервера-«хозяина» инцидентов не нужны: инциденты без сервера годятся для сводки по именам.
    const repo = app.get(IncidentsRepository);
    for (const [name, kind] of [
      ['ru-bridge', 'agent_offline'],
      ['ru-bridge', 'ssh_down'],
      ['nl', 'ssh_down'],
    ] as const) {
      const row = await repo.open({
        serverId: null,
        serverName: name,
        kind,
        severity: 'crit',
        title: `${kind === 'ssh_down' ? 'SSH недоступен' : 'Агент не в сети'} · ${name}`,
        detail: 'Тест.',
        timeline: [],
      });
      if (row) await repo.update(row.id, { status: 'resolved', resolvedAt: new Date(), resolvedBy: 'auto' });
    }
  }, 60_000);

  afterAll(async () => {
    await app?.close();
  });

  it('пустой ответ модели: ход не заканчивается «не удалось», её подталкивают ответить', async () => {
    const res = await ask('empty');
    expect(res.message.content).toBe('Ответ после толчка.');
    expect(res.messages).toHaveLength(1);
    expect(JSON.stringify(fake.calls[1]?.messages)).toContain('Ответ пустой');
  });

  it('«сейчас вызываю инструмент» без вызова: обещание не сохраняется, модель вызывает и отвечает', async () => {
    const res = await ask('promise');
    expect(res.message.content).toBe('На ru-bridge больше всего инцидентов.');
    expect(res.messages.map((m) => m.content)).not.toContain(
      'Причина: нужно было вызвать list_incidents. Сейчас вызываю инструмент, чтобы дать ответ.',
    );
    expect(JSON.stringify(fake.calls[1]?.messages)).toContain('не вызвали');
    // Сводка по серверам пришла модели числами, а вложений-«инцидентов» под ответом нет.
    const toolResult = fake.calls
      .at(-1)
      ?.messages.flatMap((m) => m.content)
      .find((b) => b.type === 'tool_result');
    const payload = JSON.parse(toolResult?.type === 'tool_result' ? toolResult.content : '{}');
    expect(payload.byServer[0]).toMatchObject({ server: 'ru-bridge', total: 2 });
    expect(payload.byServer[1]).toMatchObject({ server: 'nl', total: 1 });
    expect(res.message.citations).toEqual([]);
  });

  it('модель вызывает инструменты бесконечно: в конце просят итог без инструментов', async () => {
    const res = await ask('loop');
    expect(res.message.content).toBe('Итог без инструментов.');
    expect(fake.calls.at(-1)?.tools).toEqual([]);
    expect(fake.calls.length).toBeLessThanOrEqual(10);
  });

  it('несколько сообщений: реплика по ходу работы и части итога идут отдельными сообщениями', async () => {
    const res = await ask('multi');
    expect(res.messages.map((m) => m.content)).toEqual([
      'Смотрю данные по инцидентам.',
      'Вывод: всё в порядке.',
      'Инструкция: ничего делать не нужно.',
      'Команда: uptime',
    ]);
    expect(res.message.content).toBe('Команда: uptime');
    // Вложения только у последнего; в истории беседы сообщения по порядку
    expect(res.messages.slice(0, -1).every((m) => m.citations.length === 0 && m.proposals.length === 0)).toBe(
      true,
    );
    const history = await agent.get(`/api/assistant/conversations/${res.conversationId}`).expect(200);
    const rows =
      (history.body as { items?: Array<{ role: string; content: string }> }).items ??
      (history.body as Array<{ role: string; content: string }>);
    expect(rows.filter((r) => r.role === 'assistant').map((r) => r.content)).toEqual(
      res.messages.map((m) => m.content),
    );
  });

  it('вызов инструмента не теряется, даже если провайдер пометил ответ как обычный', async () => {
    const res = await ask('stopped-with-calls');
    expect(res.message.content).toBe('Настройки прочитаны.');
  });
});
