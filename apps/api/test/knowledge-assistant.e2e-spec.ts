import type { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import {
  ASSISTANT_PERMISSION_KEYS,
  assistantChatResponseSchema,
  assistantStatusSchema,
  auditListResponseSchema,
  CSRF_HEADER,
  kbDocSchema,
  kbListResponseSchema,
  kbVersionsResponseSchema,
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
  DOCKER_INFO,
  DOCKER_INSPECT,
  FAQ_TEXT,
  GLOSSARY_TEXT,
  LSCPU_QUESTION,
  MACHINE_LIKE_LINES,
} from '../src/modules/assistant/glossary-import.fixture.js';
import { KbReviewService } from '../src/modules/assistant/kb-review.service.js';
import {
  LLM_PROVIDER,
  type LlmProvider,
  type LlmResp,
  type LlmRunInput,
} from '../src/modules/assistant/llm.provider.js';
import { SetupService } from '../src/modules/auth/setup.service.js';

if (!process.env.DATABASE_URL?.endsWith('/nodeservice_test'))
  throw new Error('e2e: DATABASE_URL должен указывать на nodeservice_test');

const LOGIN = 'admin';
const PASSWORD = 'correct horse battery staple';
const FAKE_INCIDENT = '0192c000-0000-7000-8000-0000000000aa';

/**
 * Сценарный LLM. Режим «Агент»: круг 1 — поиск в БЗ; круг 2 — предложение; круг 3 — итог.
 * Присланная статья (маркер МАНУАЛ в тексте) — зовёт save_kb_article, затем итог.
 */
class FakeLlm implements LlmProvider {
  calls = 0;
  /** Сколько раз вообще спрашивали модель: словарь терминов должен разбираться без неё. */
  runs = 0;
  /** Весь текст пользователя из последнего вызова, вместе с подсказками сервера. */
  lastUserText = '';
  async run(input: LlmRunInput): Promise<LlmResp> {
    this.runs += 1;
    const done = input.messages.some((m) => m.content.some((b) => b.type === 'tool_result'));
    const userText = input.messages
      .filter((m) => m.role === 'user')
      .flatMap((m) => m.content)
      .map((b) => (b.type === 'text' ? b.text : ''))
      .join(' ');
    this.lastUserText = userText;
    // Сценарий глоссария: по маркеру в сообщении зовём add_glossary_terms с нужным термином.
    if (userText.includes('ГЛОССАРИЙ')) {
      if (!done) {
        const t = userText.includes('CPU')
          ? { term: 'CPU', explain: 'Процессор — считает всё на сервере' }
          : userText.includes('XTLS')
            ? { term: 'XTLS', explain: 'Шифрование трафика в Xray без двойной обёртки' }
            : { term: 'SSH', explain: 'Безопасный удалённый доступ к серверу' };
        return {
          stopReason: 'tool_use',
          blocks: [{ type: 'tool_use', id: 'g1', name: 'add_glossary_terms', input: { terms: [t] } }],
        };
      }
      return { stopReason: 'end', blocks: [{ type: 'text', text: 'Добавил в глоссарий.' }] };
    }
    // Инструменты чтения: зовём все новые, а в ответ отдаём начала их результатов — проверить проводку модуля.
    if (userText.includes('ИНСТРУМЕНТЫ')) {
      if (!done)
        return {
          stopReason: 'tool_use',
          blocks: [
            { type: 'tool_use', id: 'r1', name: 'get_fleet_status', input: {} },
            { type: 'tool_use', id: 'r2', name: 'list_incidents', input: { status: 'open' } },
            { type: 'tool_use', id: 'r3', name: 'get_incident', input: { incidentId: FAKE_INCIDENT } },
            {
              type: 'tool_use',
              id: 'r4',
              name: 'get_metrics_history',
              input: { serverId: 'нет-такого', metric: 'cpuPct' },
            },
            { type: 'tool_use', id: 'r5', name: 'get_maintenance', input: { serverId: 'нет-такого' } },
          ],
        };
      const echoes = input.messages
        .flatMap((m) => m.content)
        .map((b) => (b.type === 'tool_result' ? String(b.content).slice(0, 80) : ''))
        .filter(Boolean);
      return { stopReason: 'end', blocks: [{ type: 'text', text: `ЭХО ${echoes.join(' | ')}` }] };
    }
    // Ревизия базы знаний: возвращаем причёсанный вариант (длиннее оригинала → пройдёт предохранитель).
    if (input.system.includes('редактор базы знаний')) {
      return { stopReason: 'end', blocks: [{ type: 'text', text: `${userText}\n\nПроверено ревизией.` }] };
    }
    // Поиск по прошлым беседам и Журналу: зовём инструмент и отдаём его ответ в тексте.
    if (userText.includes('НАЙДИ-В-БЕСЕДАХ') || userText.includes('НАЙДИ-В-ЖУРНАЛЕ')) {
      if (!done) {
        const journal = userText.includes('НАЙДИ-В-ЖУРНАЛЕ');
        return {
          stopReason: 'tool_use',
          blocks: [
            {
              type: 'tool_use',
              id: 's1',
              name: journal ? 'search_audit' : 'search_conversations',
              input: journal ? { category: 'assistant', limit: 25 } : { query: 'уникальныймаркерпамяти' },
            },
          ],
        };
      }
      const seen = input.messages
        .flatMap((m) => m.content)
        .map((b) => (b.type === 'tool_result' ? String(b.content) : ''))
        .join(' ');
      return { stopReason: 'end', blocks: [{ type: 'text', text: `ИНСТРУМЕНТ: ${seen}` }] };
    }
    if (userText.includes('СБОЙ-ПРОВАЙДЕРА')) throw new Error('zveno.ai ответил 400: неверный запрос');
    if (userText.includes('СБОЙ-ТАЙМАУТ'))
      throw Object.assign(new Error('signal timed out'), { name: 'TimeoutError' });
    // Модель пишет «добавил», не вызвав инструмент: после толчка вызывает (ЛОЖЬ-ПОТОМ) или упорствует (ЛОЖЬ-УПОРНО).
    if (userText.includes('ЛОЖЬ-ПОТОМ') || userText.includes('ЛОЖЬ-УПОРНО')) {
      const nudged = userText.includes('ни один инструмент не вызывали');
      if (userText.includes('ЛОЖЬ-ПОТОМ') && nudged && !done)
        return {
          stopReason: 'tool_use',
          blocks: [
            {
              type: 'tool_use',
              id: 'l1',
              name: 'add_glossary_terms',
              input: { terms: [{ term: 'Ложный термин', explain: 'Термин, добавленный после толчка' }] },
            },
          ],
        };
      if (done)
        return { stopReason: 'end', blocks: [{ type: 'text', text: 'Готово, добавил в глоссарий.' }] };
      return {
        stopReason: 'end',
        blocks: [{ type: 'text', text: 'Добавил термин в глоссарий «Пояснения».' }],
      };
    }
    // Вывод команды или словарь с вопросом: отвечает сама модель, текстом.
    if (userText.includes('ОТВЕТ-МОДЕЛИ'))
      return { stopReason: 'end', blocks: [{ type: 'text', text: 'Разобрал присланное.' }] };
    // Статья «проблема: решение»: модель сохраняет её статьёй.
    if (userText.includes('FAQ-СТАТЬЯ')) {
      if (!done)
        return {
          stopReason: 'tool_use',
          blocks: [
            {
              type: 'tool_use',
              id: 'f1',
              name: 'save_kb_article',
              input: { title: 'Частые проблемы клиентов', content: FAQ_TEXT, tags: ['клиенты'] },
            },
          ],
        };
      const seen = input.messages
        .flatMap((m) => m.content)
        .map((b) => (b.type === 'tool_result' ? String(b.content) : ''))
        .join(' ');
      return { stopReason: 'end', blocks: [{ type: 'text', text: `Ответ инструмента: ${seen}` }] };
    }
    if (userText.includes('СЛОВАРЬ-СТАТЬЯ')) {
      if (!done)
        return {
          stopReason: 'tool_use',
          blocks: [
            {
              type: 'tool_use',
              id: 'a9',
              name: 'save_kb_article',
              input: {
                title: 'Глоссарий терминов VPN',
                content: GLOSSARY_TEXT,
                tags: ['ai'],
              },
            },
          ],
        };
      const seen = input.messages
        .flatMap((m) => m.content)
        .map((b) => (b.type === 'tool_result' ? String(b.content) : ''))
        .join(' ');
      return {
        stopReason: 'end',
        blocks: [{ type: 'text', text: `Ответ инструмента: ${seen.slice(0, 120)}` }],
      };
    }
    // Тот же словарь без заголовка и под нейтральным названием: защита не зависит от слов «Глоссарий», «Термины».
    if (userText.includes('СЛОВАРЬ-ОСНОВЫ')) {
      if (!done)
        return {
          stopReason: 'tool_use',
          blocks: [
            {
              type: 'tool_use',
              id: 'a10',
              name: 'save_kb_article',
              input: {
                title: 'Основы VPN',
                content: GLOSSARY_TEXT.split('\n').slice(1).join('\n'),
                tags: [],
              },
            },
          ],
        };
      const seen = input.messages
        .flatMap((m) => m.content)
        .map((b) => (b.type === 'tool_result' ? String(b.content) : ''))
        .join(' ');
      return {
        stopReason: 'end',
        blocks: [{ type: 'text', text: `Ответ инструмента: ${seen.slice(0, 120)}` }],
      };
    }
    if (userText.includes('МАНУАЛ')) {
      if (!done)
        return {
          stopReason: 'tool_use',
          blocks: [
            {
              type: 'tool_use',
              id: 'a1',
              name: 'save_kb_article',
              input: {
                title: 'Разбор: настройка Reality',
                content: '# Reality\n\n1. Установи Xray\n2. Сгенерируй ключи',
                tags: ['ai', 'reality'],
              },
            },
          ],
        };
      return { stopReason: 'end', blocks: [{ type: 'text', text: 'Собрал и сохранил статью.' }] };
    }
    this.calls += 1;
    if (this.calls === 1)
      return {
        stopReason: 'tool_use',
        blocks: [
          { type: 'text', text: 'Смотрю базу знаний.' },
          { type: 'tool_use', id: 't1', name: 'search_kb', input: { query: 'conntrack' } },
        ],
      };
    if (this.calls === 2)
      return {
        stopReason: 'tool_use',
        blocks: [
          {
            type: 'tool_use',
            id: 't2',
            name: 'propose_action',
            input: {
              incidentId: FAKE_INCIDENT,
              preset: 'restart_node',
              title: 'Перезапустить Xray',
              description: 'Снимет пиковую нагрузку на CPU.',
            },
          },
        ],
      };
    return { stopReason: 'end', blocks: [{ type: 'text', text: 'Рекомендую поднять лимит conntrack.' }] };
  }
}

describe('knowledge + assistant e2e', () => {
  let app: INestApplication;
  let agent: InstanceType<typeof TestAgent>;
  let csrf: string;
  const fake = new FakeLlm();

  const assertPassiveKnowledge = async (message: string) => {
    const before = kbListResponseSchema.parse((await agent.get('/api/knowledge').expect(200)).body);
    const docs = await Promise.all(
      before.items.map(async (item) =>
        kbDocSchema.parse((await agent.get(`/api/knowledge/${item.id}`).expect(200)).body),
      ),
    );
    const res = assistantChatResponseSchema.parse(
      (await agent.post('/api/assistant/chat').set(CSRF_HEADER, csrf).send({ message }).expect(200)).body,
    );
    expect(res.message.proposals).toEqual([]);
    const after = kbListResponseSchema.parse((await agent.get('/api/knowledge').expect(200)).body);
    expect(after).toEqual(before);
    const afterDocs = await Promise.all(
      after.items.map(async (item) =>
        kbDocSchema.parse((await agent.get(`/api/knowledge/${item.id}`).expect(200)).body),
      ),
    );
    expect(afterDocs).toEqual(docs);
    const history = (await agent.get(`/api/assistant/conversations/${res.conversationId}`).expect(200)).body;
    expect(history.items.some((item: { content: string }) => item.content === message.trim())).toBe(true);
    return res;
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
      sql`truncate users, recovery_codes, trusted_devices, setup_tokens, servers, incidents, kb_documents, assistant_conversations cascade`,
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
  }, 60_000);

  afterAll(async () => {
    await app?.close();
  });

  it('база знаний: создание, полнотекстовый поиск, обновление, архив, удаление', async () => {
    const created = kbDocSchema.parse(
      (
        await agent
          .post('/api/knowledge')
          .set(CSRF_HEADER, csrf)
          .send({
            title: 'Лимит conntrack',
            content: 'Если conntrack близок к пределу, подними net.netfilter.nf_conntrack_max.',
            tags: ['conntrack', 'сеть'],
          })
          .expect(201)
      ).body,
    );
    expect(created.title).toBe('Лимит conntrack');

    const found = kbListResponseSchema.parse(
      (await agent.get('/api/knowledge?q=conntrack').expect(200)).body,
    );
    expect(found.items.some((d) => d.id === created.id)).toBe(true);

    const miss = kbListResponseSchema.parse(
      (await agent.get('/api/knowledge?q=совершенно_другое').expect(200)).body,
    );
    expect(miss.items).toHaveLength(0);

    await agent
      .put(`/api/knowledge/${created.id}`)
      .set(CSRF_HEADER, csrf)
      .send({ archived: true })
      .expect(200);
    const active = kbListResponseSchema.parse((await agent.get('/api/knowledge').expect(200)).body);
    expect(active.items.some((d) => d.id === created.id)).toBe(false);

    await agent.delete(`/api/knowledge/${created.id}`).set(CSRF_HEADER, csrf).expect(204);
    await agent.get(`/api/knowledge/${created.id}`).expect(404);
  });

  it('история версий: изменение создаёт версию, откат восстанавливает содержимое', async () => {
    const created = kbDocSchema.parse(
      (
        await agent
          .post('/api/knowledge')
          .set(CSRF_HEADER, csrf)
          .send({ title: 'Версии', content: 'v1' })
          .expect(201)
      ).body,
    );
    // изменение → снимок прежнего состояния в историю
    await agent
      .put(`/api/knowledge/${created.id}`)
      .set(CSRF_HEADER, csrf)
      .send({ content: 'v2' })
      .expect(200);
    const versions = kbVersionsResponseSchema.parse(
      (await agent.get(`/api/knowledge/${created.id}/versions`).expect(200)).body,
    );
    const first = versions.items[0];
    if (!first) throw new Error('версия не создана');
    expect(first.reason).toBe('edit');
    // откат к версии → контент снова v1
    const reverted = kbDocSchema.parse(
      (
        await agent
          .post(`/api/knowledge/${created.id}/versions/${first.id}/revert`)
          .set(CSRF_HEADER, csrf)
          .expect(200)
      ).body,
    );
    expect(reverted.content).toBe('v1');
    await agent.delete(`/api/knowledge/${created.id}`).set(CSRF_HEADER, csrf).expect(204);
  });

  it('Джарвис выключен без ключа: статус false, чат — 409', async () => {
    const status = assistantStatusSchema.parse((await agent.get('/api/assistant/status').expect(200)).body);
    expect(status.enabled).toBe(false);
    await agent.post('/api/assistant/chat').set(CSRF_HEADER, csrf).send({ message: 'привет' }).expect(409);
  });

  it('чат с инструментами и предложением после установки ключа', async () => {
    // статья для контекста поиска
    await agent
      .post('/api/knowledge')
      .set(CSRF_HEADER, csrf)
      .send({ title: 'conntrack runbook', content: 'conntrack: подними nf_conntrack_max до 1048576.' })
      .expect(201);

    const enabled = assistantStatusSchema.parse(
      (
        await agent
          .put('/api/settings/assistant')
          .set(CSRF_HEADER, csrf)
          .send({ apiKey: 'sk-test-0123456789', model: 'anthropic/claude-sonnet-4-5' })
          .expect(200)
      ).body,
    );
    expect(enabled.enabled).toBe(true);

    const res = assistantChatResponseSchema.parse(
      (
        await agent
          .post('/api/assistant/chat')
          .set(CSRF_HEADER, csrf)
          .send({ message: 'Как быть с ростом conntrack?' })
          .expect(200)
      ).body,
    );
    expect(res.message.role).toBe('assistant');
    expect(res.message.content).toContain('conntrack');
    // предложение действия — human-in-the-loop
    // Предложение по несуществующему инциденту отклоняется, карточки нет (положительный путь: fleet-probe.e2e-spec)
    expect(res.message.proposals).toHaveLength(0);
    // цитата на базу знаний
    expect(res.message.citations.some((c) => c.type === 'kb')).toBe(true);

    // история беседы содержит вопрос и ответ
    const history = (await agent.get(`/api/assistant/conversations/${res.conversationId}`).expect(200)).body;
    expect(history.items.length).toBeGreaterThanOrEqual(2);

    // Фильтруем по цели (беседе) — устойчиво к накоплению append-only Журнала.
    const audit = auditListResponseSchema.parse(
      (await agent.get(`/api/audit?targetId=${res.conversationId}`).expect(200)).body,
    );
    const chatEvent = audit.items.find((e) => e.action === 'assistant.chat');
    expect(chatEvent?.category).toBe('assistant');
  });

  it('присланный мануал сохраняется статьёй с меткой AI при разрешении «Создание и правка статей»', async () => {
    const res = assistantChatResponseSchema.parse(
      (
        await agent
          .post('/api/assistant/chat')
          .set(CSRF_HEADER, csrf)
          .send({ message: 'Вот скопированная страница про Reality… МАНУАЛ' })
          .expect(200)
      ).body,
    );
    const cited = res.message.citations.find((c) => c.type === 'kb');
    expect(cited?.label).toBe('Разбор: настройка Reality');
    // Запись прошла — предупреждения «ничего не сохранено» нет.
    expect(res.message.content).toBe('Собрал и сохранил статью.');
    const doc = kbDocSchema.parse((await agent.get(`/api/knowledge/${cited?.id}`).expect(200)).body);
    expect(doc.source).toBe('ai');
    // Убираем за собой: следующие проверки сравнивают базу знаний до и после.
    await agent.delete(`/api/knowledge/${cited?.id}`).set(CSRF_HEADER, csrf).expect(204);
  });

  it('чат пополняет «Пояснения»: новый термин добавляется, повтор не дублируется и не выдаётся за запись', async () => {
    const chat = async (message: string) =>
      assistantChatResponseSchema.parse(
        (await agent.post('/api/assistant/chat').set(CSRF_HEADER, csrf).send({ message }).expect(200)).body,
      );
    const glossary = async () => {
      const list = kbListResponseSchema.parse((await agent.get('/api/knowledge').expect(200)).body);
      const id = list.items.find((d) => d.title === 'Пояснения')?.id;
      return kbDocSchema.parse((await agent.get(`/api/knowledge/${id}`).expect(200)).body).content;
    };
    expect(await glossary()).not.toContain('XTLS');
    expect((await chat('Объясни XTLS — ГЛОССАРИЙ')).message.content).toBe('Добавил в глоссарий.');
    expect((await glossary()).match(/XTLS/g)).toHaveLength(1);
    // Повтор ничего не добавил: Ассистент не вправе сказать «добавил» без оговорки.
    expect((await chat('Опять XTLS — ГЛОССАРИЙ')).message.content).toContain('ничего не сохранено');
    expect((await glossary()).match(/XTLS/g)).toHaveLength(1);
  });

  it('чат читает события и отклоняет удалённые инструменты старых серверов', async () => {
    const res = assistantChatResponseSchema.parse(
      (
        await agent
          .post('/api/assistant/chat')
          .set(CSRF_HEADER, csrf)
          .send({ message: 'Что в парке? ИНСТРУМЕНТЫ' })
          .expect(200)
      ).body,
    );
    expect(res.message.content).toContain('не разрешён');
    expect(res.message.content).toContain('matched');
    expect(res.message.reachability).toEqual([]);
  });

  it('глоссарий «Пояснения» есть всегда: закреплён сверху, не удаляется, не архивируется и не переименовывается', async () => {
    const list = kbListResponseSchema.parse((await agent.get('/api/knowledge').expect(200)).body);
    const gloss = list.items.find((d) => d.title === 'Пояснения');
    expect(gloss?.pinned).toBe(true);
    // Закреплённая статья идёт первой, что бы ни менялось у остальных.
    expect(list.items.findIndex((item) => item.id === gloss?.id)).toBeLessThan(
      list.items.findIndex((item) => !item.pinned),
    );
    const id = gloss?.id ?? '';
    await agent.delete(`/api/knowledge/${id}`).set(CSRF_HEADER, csrf).expect(409);
    await agent.put(`/api/knowledge/${id}`).set(CSRF_HEADER, csrf).send({ archived: true }).expect(409);
    await agent.put(`/api/knowledge/${id}`).set(CSRF_HEADER, csrf).send({ title: 'Другое' }).expect(409);
    // Содержимое править можно: администратор дописывает термины сам.
    await agent
      .put(`/api/knowledge/${id}`)
      .set(CSRF_HEADER, csrf)
      .send({
        content: '# Пояснения\n\n| Термин | Простыми словами |\n| --- | --- |\n| VPN | Защищённый канал |\n',
      })
      .expect(200);
    // Разрешения «глоссарий» больше нет в настройках Джарвиса.
    const status = assistantStatusSchema.parse((await agent.get('/api/assistant/status').expect(200)).body);
    expect(Object.keys(status.permissions).sort()).toEqual([...ASSISTANT_PERMISSION_KEYS].sort());
    expect(status.permissions).not.toHaveProperty('glossary');
  });

  it('ревизия базы знаний: безопасно правит статьи, снимает версию, пишет отчёт', async () => {
    const created = kbDocSchema.parse(
      (
        await agent
          .post('/api/knowledge')
          .set(CSRF_HEADER, csrf)
          .send({
            title: 'Статья на ревизию',
            content: 'Достаточно длинный текст статьи для ревизии, чтобы пройти предохранитель длины.',
          })
          .expect(201)
      ).body,
    );
    const res = await app.get(KbReviewService).runReview();
    expect(res.skipped).toBeNull();
    expect(res.reviewed).toBeGreaterThanOrEqual(1);
    expect(res.changed).toBeGreaterThanOrEqual(1);

    // статья изменена, и перед этим снят снимок версии с причиной review
    const after = kbDocSchema.parse((await agent.get(`/api/knowledge/${created.id}`).expect(200)).body);
    expect(after.content).not.toBe(created.content);
    const versions = kbVersionsResponseSchema.parse(
      (await agent.get(`/api/knowledge/${created.id}/versions`).expect(200)).body,
    );
    expect(versions.items.some((v) => v.reason === 'review')).toBe(true);

    // отчёт в Журнале
    const audit = auditListResponseSchema.parse(
      (await agent.get('/api/audit?category=knowledge').expect(200)).body,
    );
    expect(audit.items.some((e) => e.action === 'kb.reviewed')).toBe(true);
    await agent.delete(`/api/knowledge/${created.id}`).set(CSRF_HEADER, csrf).expect(204);
  });

  it('присланный словарь проходит модель без автоматической записи, полный вопрос сохраняется', async () => {
    const runs = fake.runs;
    await assertPassiveKnowledge(GLOSSARY_TEXT);
    expect(fake.runs).toBeGreaterThan(runs);
    await assertPassiveKnowledge(GLOSSARY_TEXT);
  });

  describe('вывод команды, «проблема: решение» и вопрос со словарём разбирает модель', () => {
    const glossary = async () => {
      const list = kbListResponseSchema.parse((await agent.get('/api/knowledge').expect(200)).body);
      const gloss = list.items.find((d) => d.title === 'Пояснения');
      return kbDocSchema.parse((await agent.get(`/api/knowledge/${gloss?.id}`).expect(200)).body).content;
    };
    const chat = async (message: string) =>
      assistantChatResponseSchema.parse(
        (await agent.post('/api/assistant/chat').set(CSRF_HEADER, csrf).send({ message }).expect(200)).body,
      );

    it('вопрос с выводом lscpu, docker inspect и docker info: отвечает модель, «Пояснения» не пополняются', async () => {
      for (const [name, text] of Object.entries({ LSCPU_QUESTION, DOCKER_INSPECT, DOCKER_INFO })) {
        const before = await glossary();
        const runs = fake.runs;
        const res = await chat(`${text}\nОТВЕТ-МОДЕЛИ`);
        expect(fake.runs, name).toBeGreaterThan(runs);
        expect(res.message.content, name).toBe('Разобрал присланное.');
        expect(res.message.citations, name).toEqual([]);
        expect(await glossary(), name).toBe(before);
      }
      const after = await glossary();
      for (const junk of ['Spectre', 'Flags', 'ResolvConfPath', 'sha256', 'Docker Buildx'])
        expect(after, junk).not.toContain(junk);
    });

    it('статья «проблема: решение» обсуждается без записи статьи или терминов', async () => {
      await assertPassiveKnowledge(FAQ_TEXT);
    });

    it('инструкция с терминами сохраняется в беседе без изменения базы знаний', async () => {
      await assertPassiveKnowledge(`${FAQ_TEXT}\n\n# Термины\nSSH: защищённое подключение`);
    });

    it('словарь с вопросом: сервер не отвечает шаблоном, отвечает модель', async () => {
      const runs = fake.runs;
      const res = await chat(`Что думаете, всё ли тут верно? ОТВЕТ-МОДЕЛИ\n\n${GLOSSARY_TEXT}`);
      expect(fake.runs).toBeGreaterThan(runs);
      expect(res.message.content).toBe('Разобрал присланное.');
      expect(res.message.content).not.toContain('отдельную статью я не создавал');
    });

    it('словарь с техническими строками сохраняется целиком без фонового импорта', async () => {
      await assertPassiveKnowledge(`# Термины\n${MACHINE_LIKE_LINES.join('\n')}`);
    });
  });

  it('словарь отдельной статьёй не сохраняется: термины идут только в «Пояснения»', async () => {
    const res = await assertPassiveKnowledge('Собери статью, СЛОВАРЬ-СТАТЬЯ');
    expect(res.message.content).toContain('Статья-глоссарий не создана');
  });

  it('запрет статьи-словаря не зависит от её названия', async () => {
    const res = await assertPassiveKnowledge('Собери статью, СЛОВАРЬ-ОСНОВЫ');
    expect(res.message.content).toContain('Статья-глоссарий не создана');
  });

  it('ложное заявление модели о записи не приводит к записи после подсказки', async () => {
    await assertPassiveKnowledge('Запиши термин ЛОЖЬ-ПОТОМ');
  });

  it('упорное ложное заявление о записи явно исправляется предупреждением', async () => {
    const res = await assertPassiveKnowledge('Запиши термин ЛОЖЬ-УПОРНО');
    expect(res.message.content).toContain('ничего не сохранено');
  });

  it('сбой провайдера модели: понятный текст со статусом 424, а не «Что-то пошло не так на сервере»', async () => {
    const bad = await agent
      .post('/api/assistant/chat')
      .set(CSRF_HEADER, csrf)
      .send({ message: 'СБОЙ-ПРОВАЙДЕРА' })
      .expect(424);
    expect(bad.body.detail).toContain('Провайдер модели вернул ошибку 400');
    expect(bad.body.detail).not.toContain('Что-то пошло не так');
    const slow = await agent
      .post('/api/assistant/chat')
      .set(CSRF_HEADER, csrf)
      .send({ message: 'СБОЙ-ТАЙМАУТ' })
      .expect(424);
    expect(slow.body.detail).toContain('не ответил за 240 секунд');
  });

  it('память: search_conversations находит прошлую беседу и не показывает текущую', async () => {
    // Прошлая беседа с редким словом.
    await agent
      .post('/api/assistant/chat')
      .set(CSRF_HEADER, csrf)
      .send({ message: 'Запомни уникальныймаркерпамяти про сервер ru' })
      .expect(200);
    // Новая беседа ищет это слово: текущая (сама формулировка запроса) в результат не попадает.
    const res = assistantChatResponseSchema.parse(
      (
        await agent
          .post('/api/assistant/chat')
          .set(CSRF_HEADER, csrf)
          .send({ message: 'Что я говорил про уникальныймаркерпамяти? НАЙДИ-В-БЕСЕДАХ' })
          .expect(200)
      ).body,
    );
    expect(res.message.content).toContain('ИНСТРУМЕНТ:');
    expect(res.message.content).toContain('Запомни уникальныймаркерпамяти про сервер ru');
    expect(res.message.content).not.toContain('НАЙДИ-В-БЕСЕДАХ');
  });

  it('Журнал: search_audit отдаёт кто, результат и вопрос с ответом у запросов к Джарвису', async () => {
    const res = assistantChatResponseSchema.parse(
      (
        await agent
          .post('/api/assistant/chat')
          .set(CSRF_HEADER, csrf)
          .send({ message: 'Покажи запросы, НАЙДИ-В-ЖУРНАЛЕ' })
          .expect(200)
      ).body,
    );
    const raw = res.message.content.replace(/^ИНСТРУМЕНТ: /, '');
    const body = JSON.parse(raw) as {
      total: number;
      items: Array<{ who: string; result: string; action: string; details?: string }>;
    };
    expect(body.total).toBeGreaterThan(0);
    const chat = body.items.find((i) => i.action === 'assistant.chat' && i.details?.includes('question:'));
    expect(chat, 'запись «Запрос к Джарвису» с вопросом').toBeDefined();
    expect(chat?.who).toBe('admin');
    expect(chat?.result).toBe('ok');
  });

  it('ключ можно стереть — Джарвис снова выключен', async () => {
    const off = assistantStatusSchema.parse(
      (await agent.put('/api/settings/assistant').set(CSRF_HEADER, csrf).send({ clearKey: true }).expect(200))
        .body,
    );
    expect(off.enabled).toBe(false);
  });
});
