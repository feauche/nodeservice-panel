import type { Incident } from '@nodeservice/shared';
import { describe, expect, it } from 'vitest';

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

const deps = (inc: Incident | Error = incident()): ToolDeps =>
  ({
    incidents: {
      get: async () => {
        if (inc instanceof Error) throw inc;
        return inc;
      },
    },
    assistant: { level: 'intermediate' },
  }) as unknown as ToolDeps;

describe('набор инструментов Ассистента', () => {
  it('исполняющих инструментов нет, пишут только в базу знаний: любое новое имя требует осознанного решения', () => {
    // Если добавляете инструмент, добавьте его сюда только после проверки, что он ничего не меняет и не запускает.
    expect(ASSISTANT_TOOLS.map((t) => t.name).sort()).toEqual(
      [
        'add_glossary_terms',
        'find_remnawave_user',
        'get_backups',
        'get_billing',
        'get_integrations',
        'get_incident',
        'get_node_detail',
        'get_node_metrics',
        'get_panel_status',
        'get_playbook',
        'get_reference',
        'get_remnawave_profiles',
        'get_remnawave_squads',
        'get_remnawave_status',
        'get_remnawave_topology',
        'get_scenarios',
        'get_settings',
        'get_sites_and_providers',
        'list_incidents',
        // Только чтение Remnawave; POST — лишь задачи чтения подключений и геопроверки (см. remnawave-read.test.ts).
        'read_remnawave',
        'recommend_check',
        'save_kb_article',
        'search_audit',
        'search_conversations',
        'search_kb',
      ].sort(),
    );
  });
  it('удалённые действия не выполняются, даже если модель назовёт их сама', async () => {
    for (const name of [
      'propose_action',
      'propose_change',
      'run_server_check',
      'inspect_logs',
      'check_reachability',
    ])
      expect((await runTool(name, { incidentId: INC_ID }, deps())).content).toContain('не разрешён');
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
    expect(items[0]).toMatchObject({ id: 'k1', origin: 'Ассистент', tags: ['conntrack'] });
    expect(items[0].ageDays).toBeGreaterThanOrEqual(399);
    // Полная отметка: в разборе её переводят в пояс панели; обрезанная до дня по UTC дата могла отличаться на день.
    expect(items[0].updated).toBe(old.toISOString());
    expect(items[1]).toMatchObject({ origin: 'Вручную', ageDays: 0 });
    expect(r.citations.map((c) => c.id)).toEqual(['k1', 'k2']);
  });
});

describe('get_settings', () => {
  it('отдаёт мониторинг и подробность Ассистента: ни разрешений, ни автоматического разбора', async () => {
    const d = {
      ...deps(),
      monitoring: { get: async () => ({ enabled: true }) },
      incidentSettings: { get: async () => ({}) },
    } as unknown as ToolDeps;
    const r = JSON.parse((await runTool('get_settings', {}, d)).content);
    expect(r.monitoring).toEqual({ enabled: true });
    expect(r.assistant.level).toBe('intermediate');
    expect(r.assistant).not.toHaveProperty('permissions');
    expect(r.assistant.autoAnalysisStatus).toBeUndefined();
  });
});

describe('get_remnawave_status', () => {
  it('не подключена — честный ответ, без данных нет разрешения', async () => {
    const d1 = { ...deps() } as unknown as ToolDeps;
    expect((await runTool('get_remnawave_status', {}, d1)).content).toContain('не подключена');
    const d2 = {
      ...deps(),
      remnawave: {
        status: async () => ({
          connected: false,
          domain: null,
          checkedAt: null,
          error: null,
          stats: null,
          nodes: [],
          cert: null,
        }),
      },
    } as unknown as ToolDeps;
    expect((await runTool('get_remnawave_status', {}, d2)).content).toContain('не подключена');
  });

  it('подключена — отдаёт сводку, ноды и сертификат как есть, без домыслов', async () => {
    const st = {
      connected: true,
      domain: 'vpn-panel.example.com',
      checkedAt: '2026-09-27T10:00:00.000Z',
      error: null,
      stats: {
        users: { total: 870, active: 800, disabled: 40, limited: 10, expired: 20 },
        online: { now: 236, lastDay: 500, lastWeek: 700, never: 10 },
        nodesOnline: 4,
        nodesTotal: 5,
        trafficBytesLifetime: '20000000000000',
        panelVersion: '2.1.10',
        panelUptimeSec: 86400,
      },
      nodes: [
        {
          uuid: 'n1',
          name: 'bridge',
          address: '104.171.133.254',
          countryCode: 'PL',
          isConnected: true,
          isDisabled: false,
          isConnecting: false,
          lastStatusMessage: null,
          usersOnline: 42,
          trafficUsedBytes: 1000,
          trafficLimitBytes: null,
        },
      ],
      cert: { status: 'warn', expiresAt: '2026-10-03T00:00:00.000Z', daysLeft: 6, note: null },
    };
    const d = {
      ...deps(),
      servers: { list: async () => [] },
      remnawave: { status: async () => st },
    } as unknown as ToolDeps;
    const r = JSON.parse((await runTool('get_remnawave_status', {}, d)).content);
    // Сводка и сертификат — как есть; у ноды добавлено, на каком сервере панели она работает.
    expect(r).toMatchObject({
      connected: st.connected,
      panel: st.domain,
      checkedAt: st.checkedAt,
      stats: st.stats,
      nodes: st.nodes,
      cert: st.cert,
    });
    expect(r.note).toContain('SSH и агенты не используются');
  });
});

describe('get_panel_status', () => {
  it('версия, ноды, открытые события, ошибки за час и последняя копия', async () => {
    let seenFilter: Record<string, unknown> | undefined;
    const d = {
      ...deps(),
      servers: {
        list: async () => [
          { agentStatus: 'online', agentVersion: 'v0.5.4' },
          { agentStatus: 'online', agentVersion: 'v0.5.3' },
          { agentStatus: 'offline', agentVersion: 'v0.5.4' },
          { agentStatus: 'not_installed', agentVersion: null },
        ],
      },
      incidents: { list: async () => ({ items: [], counts: { open: 3, crit: 1, warn: 2 } }) },
      audit: {
        list: async (f: Record<string, unknown>) => {
          seenFilter = f;
          return {
            items: [
              {
                id: 'e1',
                occurredAt: '2026-09-26T10:00:00.000Z',
                actorType: 'system',
                actorDisplay: 'Система',
                action: 'incident.analysis.run',
                targetDisplay: 'Инцидент',
                result: 'failed',
                severity: 'warn',
                source: 'auto',
                changes: null,
                metadata: { error: 'таймаут' },
              },
            ],
            total: 7,
            page: 1,
            pageSize: 25,
            totalPages: 1,
          };
        },
      },
      lastBackup: async () => ({
        at: '2026-09-29T04:00:00.000Z',
        kind: 'авто',
        size: '42,3 МБ',
        verified: true,
      }),
    } as unknown as ToolDeps;
    const r = JSON.parse((await runTool('get_panel_status', {}, d)).content);
    expect(r.lastBackup).toEqual({
      at: '2026-09-29T04:00:00.000Z',
      kind: 'авто',
      size: '42,3 МБ',
      verified: true,
    });
    const none = JSON.parse(
      (await runTool('get_panel_status', {}, { ...d, lastBackup: async () => null } as ToolDeps)).content,
    );
    expect(none.lastBackup.note).toContain('Резервных копий');
    expect(r.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(r.uptimeMinutes).toBeGreaterThanOrEqual(0);
    expect(r.uptimeNote).toContain('после обновления');
    expect(r.nodes).toEqual({ total: null, connected: null, checkedAt: null, fresh: false, error: null });
    expect(r.servers).toBeUndefined();
    expect(r.incidents).toEqual({ open: 3, critical: 1, warning: 2 });
    expect(r.auditLastHour.failedOrDenied).toBe(7);
    expect(r.auditLastHour.latest[0]).toMatchObject({ who: 'панель', result: 'failed' });
    expect(seenFilter).toMatchObject({ result: ['failed', 'denied'], pageSize: 25 });
  });
});

describe('служебные статьи', () => {
  it('статью с названием «Правила парка» или «Пояснения» Ассистент не создаёт', async () => {
    let saved = 0;
    const d = {
      ...deps(),
      saveArticle: async () => {
        saved += 1;
        return { id: 'a', title: 'x' };
      },
    } as unknown as ToolDeps;
    for (const title of ['Правила парка', ' правила ПАРКА ', 'Пояснения']) {
      const r = await runTool('save_kb_article', { title, content: '# Текст\n\n1. Шаг' }, d);
      expect(r.content, title).toContain('служебная статья');
    }
    expect(saved).toBe(0);
  });
});

describe('обрезанный вызов инструмента', () => {
  it('не выполняется и объясняет модели, что дело в длине, а не в «пустом заголовке»', async () => {
    let saved = false;
    const d = {
      ...deps(),
      saveArticle: async () => {
        saved = true;
        return { id: 'x', title: 'x' };
      },
    } as unknown as ToolDeps;
    const r = await runTool('save_kb_article', { __truncated: true }, d);
    expect(saved).toBe(false);
    expect(r.content).toMatch(/оборвался на пределе длины/);
    expect(r.content).toMatch(/часть 1/);
  });
});
