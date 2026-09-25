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
