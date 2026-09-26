import { ASSISTANT_PERMISSIONS_DEFAULT, type AssistantPermissions, type Incident } from '@nodeservice/shared';
import { describe, expect, it } from 'vitest';

import { toolsFor } from './assistant.read-tools.js';
import { ASSISTANT_TOOLS, runTool, type ToolDeps } from './assistant.tools.js';

const INC_ID = '0192c000-0000-7000-8000-0000000000e1';

const incident = (over: Partial<Incident> = {}): Incident =>
  ({
    id: INC_ID,
    serverId: '0192c000-0000-7000-8000-00000000000a',
    serverName: 'de-1',
    kind: 'disk_high',
    severity: 'warn',
    status: 'open',
    title: 'Диск',
    detail: '',
    openedAt: '2026-09-25T09:00:00.000Z',
    resolvedAt: null,
    resolvedBy: null,
    timeline: [],
    attempts: [],
    proposal: null,
    snapshot: null,
    analysis: null,
    ...over,
  }) as Incident;

const deps = (inc: Incident | Error = incident(), perms: Partial<AssistantPermissions> = {}): ToolDeps =>
  ({
    incidents: {
      get: async () => {
        if (inc instanceof Error) throw inc;
        return inc;
      },
    },
    assistant: { level: 'intermediate' },
    permissions: { ...ASSISTANT_PERMISSIONS_DEFAULT, ...perms },
  }) as unknown as ToolDeps;

const propose = (arg: Record<string, unknown>, d = deps()) =>
  runTool('propose_action', { incidentId: INC_ID, reason: 'Потому что.', ...arg }, d);

describe('набор инструментов Джарвиса', () => {
  it('исполняющих инструментов нет: любое новое имя требует осознанного решения', () => {
    // Если добавляете инструмент, добавьте его сюда только после проверки, что он не меняет серверы сам (T2/T3).
    expect(ASSISTANT_TOOLS.map((t) => t.name).sort()).toEqual(
      [
        'add_glossary_terms',
        'check_reachability',
        'get_fleet_status',
        'get_incident',
        'get_maintenance',
        'get_metrics_history',
        'get_playbook',
        'get_reference',
        'get_server_detail',
        'get_settings',
        'inspect_node_logs',
        'inspect_processes',
        'list_incidents',
        'propose_action',
        'save_kb_article',
        'search_audit',
        'search_conversations',
        'search_kb',
      ].sort(),
    );
  });
  it('в описании propose_action сказано, что запускает администратор', () => {
    expect(ASSISTANT_TOOLS.find((t) => t.name === 'propose_action')?.description).toContain('нажимает');
  });
});

describe('propose_action', () => {
  it('без разрешения «Карточки предложений» карточки нет, шаг называется текстом', async () => {
    const r = await propose({ preset: 'tmp_clean' }, deps(incident(), { proposals: false }));
    expect(r.proposals).toEqual([]);
    expect(r.content).toContain('выключены в разрешениях');
  });
  it('карточки предложений выключены — инструмент не попадает к модели', () => {
    const names = toolsFor(ASSISTANT_TOOLS, { ...ASSISTANT_PERMISSIONS_DEFAULT, proposals: false }).map(
      (t) => t.name,
    );
    expect(names).not.toContain('propose_action');
    expect(names).toContain('get_incident');
  });
  it('T2 из цепочки — карточка; название и последствия берутся из реестра, а не от модели', async () => {
    const r = await propose({
      preset: 'tmp_clean',
      title: 'Безобидная уборка',
      description: 'ничего страшного',
    });
    expect(r.proposals).toHaveLength(1);
    const p = r.proposals[0];
    expect(p).toMatchObject({
      kind: 'autofix',
      incidentId: INC_ID,
      preset: 'tmp_clean',
      level: 'T2',
      title: 'Очистить временные файлы',
    });
    expect(p?.description).toContain('Потому что.');
    expect(p?.description).toContain('Последствия');
    expect(JSON.stringify(p)).not.toContain('Безобидная уборка');
  });
  it('T0 и T1 тоже карточкой', async () => {
    expect((await propose({ preset: 'disk_inspect' })).proposals[0]?.level).toBe('T0');
    expect((await propose({ preset: 'free_disk' })).proposals[0]?.level).toBe('T1');
  });
  it('T3 карточкой не предлагается: модели говорят дать команду текстом', async () => {
    const r = await propose({ preset: 'reboot' }, deps(incident({ kind: 'node_down' })));
    expect(r.proposals).toEqual([]);
    expect(r.content).toContain('только вручную');
    expect(r.content).toContain('reboot');
  });
  it('шаг вне цепочки этого инцидента, неизвестный ключ и чужой вид отклоняются', async () => {
    for (const preset of ['node_up', 'restart_node', 'rm_rf', '', 'docker_prune']) {
      const r = await propose({ preset });
      expect(r.proposals, preset).toEqual([]);
      expect(r.content, preset).toContain('нет в цепочке');
    }
  });
  it('закрытый инцидент, удалённый сервер, несуществующий инцидент и идущая попытка', async () => {
    expect(
      (await propose({ preset: 'tmp_clean' }, deps(incident({ status: 'resolved' })))).content,
    ).toContain('закрыт');
    expect((await propose({ preset: 'tmp_clean' }, deps(incident({ serverId: null })))).content).toContain(
      'Сервера этого инцидента больше нет',
    );
    expect((await propose({ preset: 'tmp_clean' }, deps(new Error('404')))).content).toContain('не найден');
    const running = incident({
      attempts: [
        {
          id: 'a',
          action: 'free_disk',
          level: 'T1',
          by: 'auto',
          status: 'running',
          startedAt: '',
          finishedAt: null,
          steps: [],
          log: '',
        },
      ],
    });
    expect((await propose({ preset: 'tmp_clean' }, deps(running))).content).toContain('идёт попытка');
    for (const bad of [await propose({ preset: 'tmp_clean' }, deps(incident({ status: 'resolved' })))])
      expect(bad.proposals).toEqual([]);
  });
  it('id инцидента берётся из дела, а не из ввода модели', async () => {
    const r = await runTool(
      'propose_action',
      { incidentId: INC_ID.toUpperCase(), preset: 'tmp_clean', reason: 'x' },
      deps(),
    );
    expect(r.proposals[0]?.incidentId).toBe(INC_ID);
  });
});

describe('глоссарий и статьи', () => {
  const kbDeps = (over: Record<string, unknown> = {}) =>
    ({
      ...deps(),
      addGlossary: async () => ({ id: 'g1', added: 1, skipped: ['SSH', 'CPU'], updated: [] }),
      saveArticle: async () => ({ id: 'a1', title: 'Готово' }),
      ...over,
    }) as unknown as ToolDeps;

  it('ответ инструмента называет повторы: модель видит, что они не добавлены', async () => {
    const r = await runTool(
      'add_glossary_terms',
      {
        terms: [
          { term: 'SSH', explain: 'Удалённый доступ' },
          { term: 'CPU', explain: 'Процессор' },
          { term: 'OOM', explain: 'Нет памяти' },
        ],
      },
      kbDeps(),
    );
    expect(r.content).toContain('получено 3, добавлено новых 1, уже были 2');
    expect(r.content).toContain('Уже были, не добавлены: SSH, CPU');
    expect(r.citations).toEqual([{ type: 'kb', id: 'g1', label: 'Пояснения' }]);
  });
  it('флаг update доходит до глоссария, остальные поля не теряются', async () => {
    let seen: unknown;
    await runTool(
      'add_glossary_terms',
      {
        terms: [
          { term: 'OOM', explain: 'Нет памяти', update: true },
          { term: 'CPU', explain: 'Процессор' },
        ],
      },
      kbDeps({
        addGlossary: async (t: unknown) => {
          seen = t;
          return { id: 'g1', added: 0, skipped: [], updated: ['OOM'] };
        },
      }),
    );
    expect(seen).toEqual([
      { term: 'OOM', explain: 'Нет памяти', update: true },
      { term: 'CPU', explain: 'Процессор' },
    ]);
  });
  it('больше тридцати терминов за вызов принимается (словарь целиком)', async () => {
    let count = 0;
    const terms = Array.from({ length: 120 }, (_, i) => ({
      term: `Термин${i}`,
      explain: 'Пояснение к термину',
    }));
    await runTool(
      'add_glossary_terms',
      { terms },
      kbDeps({
        addGlossary: async (t: unknown[]) => {
          count = t.length;
          return { id: 'g1', added: t.length, skipped: [], updated: [] };
        },
      }),
    );
    expect(count).toBe(120);
  });
  it('статья-глоссарий не сохраняется, обычная статья сохраняется', async () => {
    const table = Array.from(
      { length: 6 },
      (_, i) => `Термин${i}: система у оператора, которая смотрит на вид трафика`,
    ).join('\n');
    const refused = await runTool(
      'save_kb_article',
      { title: 'Глоссарий терминов', content: table },
      kbDeps(),
    );
    expect(refused.content).toContain('Статья-глоссарий не создана');
    expect(refused.citations).toEqual([]);
    const ok = await runTool(
      'save_kb_article',
      { title: 'Установка ноды', content: '# Установка\n\n1. Поставьте Docker\n2. Запустите контейнер' },
      kbDeps(),
    );
    expect(ok.content).toContain('Статья сохранена');
  });
});

describe('search_audit и search_conversations', () => {
  const auditEntry = {
    id: 'e1',
    occurredAt: '2026-09-26T10:00:00.000Z',
    actorType: 'admin',
    actorDisplay: 'lumaxadmnode',
    action: 'assistant.chat',
    targetDisplay: 'Беседа',
    result: 'ok',
    severity: 'info',
    source: 'manual',
    changes: null,
    metadata: { question: 'Что с ru?', answer: 'Нода остановлена' },
  };
  const withAudit = (seen: { filter?: Record<string, unknown> } = {}) =>
    ({
      ...deps(),
      audit: {
        list: async (f: Record<string, unknown>) => {
          seen.filter = f;
          return { items: [auditEntry], total: 40, page: 1, pageSize: 5, totalPages: 8 };
        },
      },
    }) as unknown as ToolDeps;

  it('журнал: кто, результат, выдержка из деталей и общее число; фильтры доходят до запроса', async () => {
    const seen: { filter?: Record<string, unknown> } = {};
    const r = await runTool(
      'search_audit',
      { query: 'ru', sinceMinutes: 60, category: 'assistant', failuresOnly: true, limit: 200 },
      withAudit(seen),
    );
    const body = JSON.parse(r.content);
    expect(body.total).toBe(40);
    expect(body.shown).toBe(1);
    expect(body.items[0]).toMatchObject({ who: 'lumaxadmnode', result: 'ok', target: 'Беседа' });
    expect(body.items[0].details).toContain('question: Что с ru?');
    expect(seen.filter).toMatchObject({
      q: 'ru',
      category: ['assistant'],
      result: ['failed', 'denied'],
      pageSize: 25,
    });
    expect(seen.filter?.from).toBeTruthy();
  });
  it('журнал: неизвестный раздел игнорируется, размер страницы не меньше пяти', async () => {
    const seen: { filter?: Record<string, unknown> } = {};
    await runTool('search_audit', { category: 'что-то', limit: 1 }, withAudit(seen));
    expect(seen.filter).not.toHaveProperty('category');
    expect(seen.filter?.pageSize).toBe(5);
  });

  const withPast = (rows: unknown[], seen: { exclude?: string } = {}) =>
    ({
      ...deps(),
      conversationId: 'cur',
      conversations: {
        recentMessages: async (_n: number, exclude?: string) => {
          seen.exclude = exclude;
          return rows;
        },
      },
    }) as unknown as ToolDeps;

  it('прошлые беседы: находит, исключает текущую, при пустом результате не даёт уверенно отрицать', async () => {
    const seen: { exclude?: string } = {};
    const rows = [
      {
        conversationId: 'c1',
        title: 'Про ru',
        role: 'user',
        content: 'Почему упал сервер ru?',
        createdAt: new Date('2026-09-25T10:00:00Z'),
      },
    ];
    const hit = await runTool('search_conversations', { query: 'упал ru' }, withPast(rows, seen));
    expect(seen.exclude).toBe('cur');
    expect(JSON.parse(hit.content).items[0]).toMatchObject({ chat: 'Про ru', who: 'администратор' });
    const none = await runTool('search_conversations', { query: 'nginx' }, withPast(rows));
    expect(none.content).toContain('ничего не найдено');
    expect(none.content).toContain('Не утверждайте');
    const empty = await runTool('search_conversations', { query: 'а' }, withPast(rows));
    expect(empty.content).toContain('Пустой запрос');
  });
});

describe('search_kb: свежесть и происхождение', () => {
  it('у статьи есть дата, возраст в днях, происхождение и теги', async () => {
    const old = new Date(Date.now() - 400 * 86_400_000);
    const d = {
      ...deps(),
      kb: {
        searchForContext: async () => [
          {
            id: 'k1',
            title: 'Лимит conntrack',
            content: 'Текст',
            updatedAt: old,
            source: 'ai',
            tags: ['conntrack'],
          },
          { id: 'k2', title: 'Reality', content: 'Текст', updatedAt: new Date(), source: 'self', tags: [] },
        ],
      },
    } as unknown as ToolDeps;
    const r = await runTool('search_kb', { query: 'conntrack' }, d);
    const items = JSON.parse(r.content);
    expect(items[0]).toMatchObject({ id: 'k1', origin: 'Джарвис', tags: ['conntrack'] });
    expect(items[0].ageDays).toBeGreaterThanOrEqual(399);
    expect(items[0].updated).toBe(old.toISOString().slice(0, 10));
    expect(items[1]).toMatchObject({ origin: 'Вручную', ageDays: 0 });
    expect(r.citations.map((c) => c.id)).toEqual(['k1', 'k2']);
  });
});

describe('get_settings: состояние автоматического разбора', () => {
  it('показывает последний запуск и счётчик за час, если панель их отдаёт', async () => {
    const d = {
      ...deps(),
      permissions: { ...ASSISTANT_PERMISSIONS_DEFAULT, autoAnalysis: true },
      autochecks: { get: async () => ({}) },
      incidentSettings: { get: async () => ({}) },
      autoAnalysis: () => ({ lastRunAt: '2026-09-26T10:00:00.000Z', startedLastHour: 2, limitPerHour: 5 }),
    } as unknown as ToolDeps;
    const r = JSON.parse((await runTool('get_settings', {}, d)).content);
    expect(r.assistant.autoAnalysisStatus).toMatchObject({
      lastRunAt: '2026-09-26T10:00:00.000Z',
      startedLastHour: 2,
      limitPerHour: 5,
    });
    expect(r.assistant.autoAnalysisStatus.note).toContain('с момента запуска панели');
    expect(r.assistant.permissions.autoAnalysis).toBe(true);
  });
});
