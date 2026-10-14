import type { Scenario, ScenarioRun } from '@nodeservice/shared';
import { describe, expect, it } from 'vitest';

import { recentHistory } from './assistant.history.js';
import { runPanelTool, safeForAssistant } from './assistant.panel-tools.js';
import { runTool, type ToolDeps } from './assistant.tools.js';

const NODE = '0192c000-0000-7000-8000-0000000000d1';
const RULE: Scenario = {
  id: '0192c000-0000-7000-8000-0000000000c1',
  name: 'Скрыть при падении',
  enabled: true,
  scope: 'selected',
  nodes: [NODE],
  hostBindings: [],
  trigger: 'offline',
  conditions: ['offline', 'tcp_unreachable'],
  conditionMode: 'all',
  holdMinutes: 2,
  actions: ['check_tcp', 'hide_host'],
  renameMode: 'append',
  renameText: '',
  autoRestore: true,
  cooldownMinutes: 30,
};
const RUN: ScenarioRun = {
  id: 'r1',
  ruleId: RULE.id,
  ruleName: RULE.name,
  t: Date.now() - 3_600_000,
  nodeUuid: NODE,
  nodeName: 'de-1',
  kind: 'run',
  title: 'Скрыть при падении — de-1',
  steps: [
    { text: 'Порт недоступен из РФ', tone: 'warn', action: 'check_tcp', n: 1, word: 'недоступен из РФ' },
  ],
  failed: false,
};
const scenarios = {
  rules: async () => [RULE],
  runs: async () => [RUN],
  marked: async () => 1,
  timeZone: async () => 'Asia/Omsk',
  nodeNames: async () => new Map([[NODE, 'de-1']]),
};

describe('Ассистент читает разделы панели', () => {
  it('сценарии: правила словами и сводка срабатываний', async () => {
    const out = await runPanelTool('get_scenarios', {}, { scenarios });
    const data = JSON.parse(out?.content ?? '{}');
    expect(data.items[0]).toMatchObject({
      name: 'Скрыть при падении',
      nodes: ['de-1'],
      conditions: 'Нода потеряла связь И TCP недоступен',
      steps: ['Проверить TCP', 'Скрыть Host'],
      day: 1,
      lastRun: { node: 'de-1' },
    });
    expect(data.tiles).toMatchObject({ total: 1, marked: 1 });
    expect(data.tiles.daySlots).toBeUndefined();
  });

  it('сценарий по имени: правило и срабатывания по шагам', async () => {
    const out = await runPanelTool('get_scenarios', { scenario: 'скрыть' }, { scenarios });
    const data = JSON.parse(out?.content ?? '{}');
    expect(data.rule.name).toBe('Скрыть при падении');
    expect(data.runs[0]).toMatchObject({
      node: 'de-1',
      steps: [{ n: 1, step: 'Проверить TCP', result: 'недоступен из РФ' }],
    });
    const none = JSON.parse(
      (await runPanelTool('get_scenarios', { scenario: 'нет такого' }, { scenarios }))?.content ?? '{}',
    );
    expect(none.error).toContain('нет');
  });

  it('интеграции: не подключённая — подсказка, ошибка одной — не роняет остальные; ключи скрыты', async () => {
    const out = await runPanelTool(
      'get_integrations',
      {},
      {
        integrations: {
          dpi: async () => ({ connected: false, hint: 'DPI Checker не подключён' }),
          dns: async () => {
            throw new Error('Cloudflare не ответил');
          },
          bs: async () => ({
            connected: true,
            workspace: { apiKey: 'bs-secret', balance: 5, email: 'me@example.com' },
          }),
        },
      },
    );
    const data = JSON.parse(out?.content ?? '{}');
    expect(data.dpi.connected).toBe(false);
    expect(data.dns.error).toBe('Cloudflare не ответил');
    expect(data.bs.workspace.balance).toBe(5);
    expect(out?.content).not.toContain('bs-secret');
    expect(out?.content).not.toContain('me@example.com');
  });

  it('копии: пароль и ключи хранилища не уходят модели', async () => {
    const out = await runPanelTool(
      'get_backups',
      {},
      {
        backups: {
          list: async () => ({ items: [{ name: 'nodeservice-backup-1.tar.gz.enc', size: 10 }] }),
          settings: async () => ({
            passwordSet: true,
            offsite: { secretAccessKey: 'aws-secret', bucket: 'b' },
          }),
        },
      },
    );
    expect(out?.content).toContain('passwordSet');
    expect(out?.content).not.toContain('aws-secret');
  });

  it('настройки по разделам: Telegram без токена бота', async () => {
    const deps = {
      assistant: { level: 'intermediate' },
      monitoring: { get: async () => ({ intervalSec: 60 }) },
      settings: {
        telegram: async () => ({
          destinations: [{ name: 'Чат', url: 'tgram://123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw/12345' }],
        }),
      },
    } as unknown as ToolDeps;
    const tg = await runTool('get_settings', { section: 'telegram' }, deps);
    expect(tg.content).toContain('tgram://[токен скрыт]');
    expect(tg.content).not.toContain('AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw');
    const def = JSON.parse((await runTool('get_settings', {}, deps)).content);
    expect(def.monitoring).toEqual({ intervalSec: 60 });
    expect(def.telegram).toBeUndefined();
  });

  it('безопасная копия: секретные поля и почта скрыты, адреса и длинные списки — коротко', () => {
    const safe = safeForAssistant({
      token: 'x',
      address: '203.0.113.10',
      note: 'пишите на admin@example.com',
      list: Array.from({ length: 45 }, (_, i) => i),
    }) as Record<string, unknown>;
    expect(safe.token).toBe('[скрыто]');
    expect(safe.address).toBe('203.0.113.10');
    expect(safe.note).toBe('пишите на [скрыто]');
    expect((safe.list as unknown[]).at(-1)).toBe('…ещё 5');
  });
});

describe('история беседы для модели', () => {
  const msg = (role: string, size: number) => ({ role, content: 'x'.repeat(size) });

  it('короткая беседа уходит целиком', () => {
    const rows = [msg('user', 10), msg('assistant', 10), msg('user', 10)];
    expect(recentHistory(rows)).toEqual({ items: rows, omitted: 0 });
  });

  it('длинная — только свежий хвост в бюджете, первым идёт вопрос владельца', () => {
    const rows = [
      msg('user', 50),
      msg('assistant', 50),
      msg('user', 50),
      msg('assistant', 50),
      msg('user', 50),
    ];
    const kept = recentHistory(rows, 160);
    expect(kept.omitted).toBe(2);
    expect(kept.items[0]?.role).toBe('user');
    expect(kept.items).toHaveLength(3);
  });

  it('текущий вопрос входит всегда, даже больше бюджета', () => {
    const rows = [msg('user', 10), msg('assistant', 10), msg('user', 500)];
    const kept = recentHistory(rows, 100);
    expect(kept.items).toEqual([rows[2]]);
    expect(kept.omitted).toBe(2);
  });

  it('предел по числу сообщений', () => {
    const rows = Array.from({ length: 60 }, (_, i) => msg(i % 2 ? 'assistant' : 'user', 1));
    const kept = recentHistory(rows, 1_000_000, 40);
    expect(kept.items.length).toBeLessThanOrEqual(40);
    expect(kept.items[0]?.role).toBe('user');
  });
});
