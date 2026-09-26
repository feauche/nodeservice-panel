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
import { GLOSSARY_TEXT, GLOSSARY_TEXT_TERMS } from '../src/modules/assistant/glossary-import.fixture.js';
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
 * Режим «Анализ» (в системном промпте есть маркер) — зовёт save_kb_article, затем итог.
 */
class FakeLlm implements LlmProvider {
  calls = 0;
  /** Сколько раз вообще спрашивали модель: словарь терминов должен разбираться без неё. */
  runs = 0;
  async run(input: LlmRunInput): Promise<LlmResp> {
    this.runs += 1;
    const done = input.messages.some((m) => m.content.some((b) => b.type === 'tool_result'));
    const userText = input.messages
      .filter((m) => m.role === 'user')
      .flatMap((m) => m.content)
      .map((b) => (b.type === 'text' ? b.text : ''))
      .join(' ');
    // Сценарий глоссария: по маркеру в сообщении зовём add_glossary_terms с нужным термином.
    if (userText.includes('ГЛОССАРИЙ')) {
      if (!done) {
        const t = userText.includes('CPU')
          ? { term: 'CPU', explain: 'Процессор — считает всё на сервере' }
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
    if (input.system.includes('РЕЖИМ «АНАЛИЗ»') && userText.includes('СЛОВАРЬ-СТАТЬЯ')) {
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
    if (input.system.includes('РЕЖИМ «АНАЛИЗ»')) {
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

  it('режим «Анализ»: агент сам создаёт статью (source=ai) при разрешении kbWrite', async () => {
    const res = assistantChatResponseSchema.parse(
      (
        await agent
          .post('/api/assistant/chat')
          .set(CSRF_HEADER, csrf)
          .send({ message: 'Вот скопированная страница про Reality…', mode: 'analysis' })
          .expect(200)
      ).body,
    );
    // цитата на созданную статью
    expect(res.message.citations.some((c) => c.type === 'kb')).toBe(true);
    // статья реально появилась в базе знаний с меткой AI
    const list = kbListResponseSchema.parse((await agent.get('/api/knowledge').expect(200)).body);
    const made = list.items.find((d) => d.title === 'Разбор: настройка Reality');
    expect(made?.source).toBe('ai');
  });

  it('режим «Анализ»: без разрешения kbWrite статья не создаётся', async () => {
    await agent
      .put('/api/settings/assistant')
      .set(CSRF_HEADER, csrf)
      .send({ permissions: { kbWrite: false } })
      .expect(200);
    await agent
      .post('/api/assistant/chat')
      .set(CSRF_HEADER, csrf)
      .send({ message: 'Ещё одна страница про Reality…', mode: 'analysis' })
      .expect(200);
    const list = kbListResponseSchema.parse((await agent.get('/api/knowledge').expect(200)).body);
    // новых статей с этим заголовком больше не появилось (осталась ровно одна из прошлого теста)
    expect(list.items.filter((d) => d.title === 'Разбор: настройка Reality')).toHaveLength(1);
    // вернём разрешение
    await agent
      .put('/api/settings/assistant')
      .set(CSRF_HEADER, csrf)
      .send({ permissions: { kbWrite: true } })
      .expect(200);
  });

  it('автоглоссарий: агент пополняет статью «Пояснения» (создание, дозапись, дедуп)', async () => {
    const glossOf = (items: Array<{ title: string; id: string; source: string }>) =>
      items.find((d) => d.title === 'Пояснения');

    // 1) первый термин → статья-глоссарий создаётся (метка AI)
    await agent
      .post('/api/assistant/chat')
      .set(CSRF_HEADER, csrf)
      .send({ message: 'Объясни SSH — ГЛОССАРИЙ' })
      .expect(200);
    let list = kbListResponseSchema.parse((await agent.get('/api/knowledge').expect(200)).body);
    const gloss = glossOf(list.items);
    if (!gloss) throw new Error('глоссарий «Пояснения» не создан');
    expect(gloss.source).toBe('ai');
    let full = kbDocSchema.parse((await agent.get(`/api/knowledge/${gloss.id}`).expect(200)).body);
    expect(full.content).toContain('SSH');

    // 2) другой термин → дозапись в ту же статью
    await agent
      .post('/api/assistant/chat')
      .set(CSRF_HEADER, csrf)
      .send({ message: 'Объясни CPU — ГЛОССАРИЙ' })
      .expect(200);
    full = kbDocSchema.parse((await agent.get(`/api/knowledge/${gloss.id}`).expect(200)).body);
    expect(full.content).toContain('SSH');
    expect(full.content).toContain('CPU');

    // 3) повтор SSH → дедуп: второй статьи «Пояснения» не появляется
    await agent
      .post('/api/assistant/chat')
      .set(CSRF_HEADER, csrf)
      .send({ message: 'Опять SSH — ГЛОССАРИЙ' })
      .expect(200);
    list = kbListResponseSchema.parse((await agent.get('/api/knowledge').expect(200)).body);
    expect(list.items.filter((d) => d.title === 'Пояснения')).toHaveLength(1);
  });

  it('инструменты чтения подключены: парк, инциденты, история, обслуживание', async () => {
    const res = await agent
      .post('/api/assistant/chat')
      .set(CSRF_HEADER, csrf)
      .send({ message: 'Что в парке? ИНСТРУМЕНТЫ' })
      .expect(200);
    const text = assistantChatResponseSchema.parse(res.body).message.content;
    expect(text).toContain('"totals"');
    expect(text).toContain('"matched"');
    expect(text.match(/не найден/g)?.length).toBeGreaterThanOrEqual(3);
  });

  it('глоссарий «Пояснения» есть всегда: закреплён сверху, не удаляется, не архивируется и не переименовывается', async () => {
    const list = kbListResponseSchema.parse((await agent.get('/api/knowledge').expect(200)).body);
    const gloss = list.items.find((d) => d.title === 'Пояснения');
    expect(gloss?.pinned).toBe(true);
    // Закреплённая статья идёт первой, что бы ни менялось у остальных.
    expect(list.items[0]?.id).toBe(gloss?.id);
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

  it('режим «Анализ»: присланный словарь терминов целиком уходит в «Пояснения», отдельной статьи нет, модель не нужна', async () => {
    const titles = async () =>
      kbListResponseSchema.parse((await agent.get('/api/knowledge').expect(200)).body).items;
    const before = await titles();
    const runs = fake.runs;
    const send = async () =>
      assistantChatResponseSchema.parse(
        (
          await agent
            .post('/api/assistant/chat')
            .set(CSRF_HEADER, csrf)
            .send({ message: GLOSSARY_TEXT, mode: 'analysis' })
            .expect(200)
        ).body,
      );
    const first = await send();
    expect(first.message.content).toContain('отдельную статью я не создавал');
    expect(first.message.content).toContain(`Найдено терминов: ${GLOSSARY_TEXT_TERMS}`);
    expect(fake.runs).toBe(runs);
    const after = await titles();
    expect(after.map((d) => d.title).sort()).toEqual(before.map((d) => d.title).sort());
    const gloss = after.find((d) => d.title === 'Пояснения');
    expect(first.message.citations).toEqual([{ type: 'kb', id: gloss?.id, label: 'Пояснения' }]);
    const doc = kbDocSchema.parse((await agent.get(`/api/knowledge/${gloss?.id}`).expect(200)).body);
    // строка, которую администратор дописал вручную в прошлом тесте, осталась на месте
    for (const t of [
      'DPI (Deep Packet Inspection)',
      'sendThrough',
      'Гео-файлы',
      '| VPN | Защищённый канал |',
    ])
      expect(doc.content, t).toContain(t);
    expect(doc.content).not.toContain('Панель: что с чем связано');

    // повторная отправка ничего не дублирует, повторы называются в ответе, версия статьи не плодится
    const versionsBefore = kbVersionsResponseSchema.parse(
      (await agent.get(`/api/knowledge/${gloss?.id}/versions`).expect(200)).body,
    ).items.length;
    const again = await send();
    expect(again.message.content).toContain('Добавлено новых: 0');
    expect(again.message.content).toContain(`Уже были в глоссарии: ${GLOSSARY_TEXT_TERMS}`);
    expect(again.message.content).toContain('DPI (Deep Packet Inspection)');
    const versionsAfter = kbVersionsResponseSchema.parse(
      (await agent.get(`/api/knowledge/${gloss?.id}/versions`).expect(200)).body,
    ).items.length;
    expect(versionsAfter).toBe(versionsBefore);
    const doc2 = kbDocSchema.parse((await agent.get(`/api/knowledge/${gloss?.id}`).expect(200)).body);
    expect(doc2.content.match(/\| DPI \(Deep Packet Inspection\) \|/g)).toHaveLength(1);
  });

  it('режим «Анализ»: попытка сохранить словарь отдельной статьёй отклоняется, модель получает подсказку про «Пояснения»', async () => {
    const res = assistantChatResponseSchema.parse(
      (
        await agent
          .post('/api/assistant/chat')
          .set(CSRF_HEADER, csrf)
          .send({ message: 'Собери статью, СЛОВАРЬ-СТАТЬЯ', mode: 'analysis' })
          .expect(200)
      ).body,
    );
    expect(res.message.content).toContain('Статья-глоссарий не создана');
    const list = kbListResponseSchema.parse((await agent.get('/api/knowledge').expect(200)).body);
    expect(list.items.some((d) => /Глоссарий терминов/.test(d.title))).toBe(false);
  });

  it('ключ можно стереть — Джарвис снова выключен', async () => {
    const off = assistantStatusSchema.parse(
      (await agent.put('/api/settings/assistant').set(CSRF_HEADER, csrf).send({ clearKey: true }).expect(200))
        .body,
    );
    expect(off.enabled).toBe(false);
  });
});
