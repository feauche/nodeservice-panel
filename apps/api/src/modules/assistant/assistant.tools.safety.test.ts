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
        'get_server_detail',
        'get_settings',
        'inspect_node_logs',
        'inspect_processes',
        'list_incidents',
        'propose_action',
        'save_kb_article',
        'search_audit',
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
