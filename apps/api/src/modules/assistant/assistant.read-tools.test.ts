import type { Incident } from '@nodeservice/shared';
import { describe, expect, it, vi } from 'vitest';

import {
  incidentCase,
  READ_TOOL_DEFS,
  type ReadDeps,
  runReadTool,
  summarizeSeries,
} from './assistant.read-tools.js';

const NODE_A = '0192c000-0000-7000-8000-00000000000a';

const incident = (over: Partial<Incident>): Incident =>
  ({
    id: '0192c000-0000-7000-8000-0000000000e1',
    serverId: null,
    serverName: 'de-1',
    nodeUuid: NODE_A,
    kind: 'node_down',
    severity: 'crit',
    status: 'open',
    title: 'Нода не на связи',
    detail: 'Remnawave не видит ноду',
    openedAt: '2026-09-25T09:00:00.000Z',
    resolvedAt: null,
    resolvedBy: null,
    timeline: [{ at: '2026-09-25T09:00:00.000Z', by: 'auto', action: 'detect', result: 'detect' }],
    attempts: [],
    proposal: null,
    snapshot: null,
    ...over,
  }) as Incident;

function deps(over: Partial<Record<keyof ReadDeps, unknown>> = {}): ReadDeps {
  return {
    incidents: {
      list: async () => ({ items: [incident({})], counts: { open: 1, crit: 1, warn: 0 } }),
      get: async () => incident({}),
    },
    ...over,
  } as unknown as ReadDeps;
}

describe('get_remnawave_profiles', () => {
  it('объявлен как чтение и передаёт выбор профиля сервису', async () => {
    expect(READ_TOOL_DEFS.some((tool) => tool.name === 'get_remnawave_profiles')).toBe(true);
    const profilesForAssistant = vi.fn(async () => ({
      connected: true,
      kind: 'node',
      name: 'Reality',
      config: { inbounds: [{ protocol: 'vless', port: 443 }] },
    }));
    const result = await runReadTool(
      'get_remnawave_profiles',
      { kind: 'node', profile: 'Reality' },
      deps({ remnawaveProfiles: { profilesForAssistant } }),
    );
    expect(profilesForAssistant).toHaveBeenCalledWith({ kind: 'node', profile: 'Reality' });
    expect(JSON.parse(result?.content ?? '{}')).toMatchObject({ name: 'Reality' });
  });
});

const call = async (name: string, arg: Record<string, unknown>, d = deps()) => {
  const out = await runReadTool(name, arg, d);
  if (!out) throw new Error('инструмент не распознан');
  // biome-ignore lint/suspicious/noExplicitAny: разбор JSON в тесте
  return { out, json: () => JSON.parse(out.content) as Record<string, any> };
};

it('в списке только чтение: никаких инструментов SSH, проверок серверов и предложений', () => {
  expect(READ_TOOL_DEFS.map((t) => t.name).sort()).toEqual([
    'find_remnawave_user',
    'get_billing',
    'get_incident',
    'get_playbook',
    'get_reference',
    'get_remnawave_profiles',
    'get_remnawave_squads',
    'get_remnawave_topology',
    'list_incidents',
  ]);
});

describe('summarizeSeries', () => {
  it('считает пик, среднее и тренд', () => {
    const pts: Array<[number, number]> = [10, 12, 11, 30, 55, 70, 90, 95, 96].map((v, i) => [
      1000 + i * 60,
      v,
    ]);
    const s = summarizeSeries(pts);
    expect(s).toMatchObject({ samples: 9, last: 96, min: 10, max: 96, trend: 'растёт' });
    expect(s?.peakAt).toBe(new Date((1000 + 8 * 60) * 1000).toISOString());
    expect(s?.points.length).toBeLessThanOrEqual(12);
  });
  it('ровная линия — «ровно», падение — «падает»', () => {
    expect(summarizeSeries([1, 2, 3, 4, 5, 6].map((i) => [i, 50] as [number, number]))?.trend).toBe('ровно');
    expect(summarizeSeries([90, 80, 60, 30, 20, 10].map((v, i) => [i, v] as [number, number]))?.trend).toBe(
      'падает',
    );
  });
  it('пустой ряд и NaN — null', () => {
    expect(summarizeSeries([])).toBeNull();
    expect(summarizeSeries([[1, Number.NaN]])).toBeNull();
  });
  it('длинный ряд ужимается до 12 точек и сохраняет последнюю', () => {
    const pts = Array.from({ length: 500 }, (_, i) => [i, i] as [number, number]);
    const s = summarizeSeries(pts);
    expect(s?.points.length).toBeLessThanOrEqual(12);
    expect(s?.points.at(-1)?.v).toBe(499);
  });
});

describe('list_incidents / get_incident', () => {
  const many = ['a', 'b', 'c'].map((x, i) =>
    incident({
      id: `0192c000-0000-7000-8000-0000000000f${i}`,
      title: x,
      openedAt: `2026-09-2${i + 1}T00:00:00.000Z`,
      nodeUuid: i === 0 ? 'other-node' : NODE_A,
    }),
  );
  const d = deps({
    incidents: {
      list: async () => ({ items: many, counts: { open: 3, crit: 3, warn: 0 } }),
      get: async () => many[0],
    },
  });
  it('новые сверху, лимит и сводка по нодам', async () => {
    const { json } = await call('list_incidents', { limit: 2 }, d);
    expect(json().items.map((i: { title: string }) => i.title)).toEqual(['c', 'b']);
    expect(json().matched).toBe(3);
    expect(json().byNode[0]).toMatchObject({ node: 'de-1', total: 3, open: 3 });
  });
  it('фильтр по ноде Remnawave', async () => {
    const { json } = await call('list_incidents', { nodeUuid: NODE_A }, d);
    expect(json().items.map((i: { title: string }) => i.title)).toEqual(['c', 'b']);
    expect((await call('list_incidents', { nodeUuid: 'нет-такой' }, d)).json().items).toHaveLength(0);
  });
  it('get_incident: событие без хвостов автопочинки, с цитатой на событие', async () => {
    const { out, json } = await call('get_incident', { incidentId: 'x' });
    expect(json()).toMatchObject({ node: 'de-1', nodeUuid: NODE_A, kind: 'node_down' });
    expect(json()).not.toHaveProperty('attempts');
    expect(json()).not.toHaveProperty('chain');
    expect(out.citations).toEqual([
      { type: 'incident', id: '0192c000-0000-7000-8000-0000000000e1', label: 'Нода не на связи' },
    ]);
    expect(incidentCase(incident({})).timeline[0]).toMatchObject({ action: 'detect' });
  });
  it('get_incident: нет такого — подсказка', async () => {
    const missing = deps({
      incidents: {
        list: async () => ({ items: [], counts: { open: 0, crit: 0, warn: 0 } }),
        get: async () => {
          throw new Error('404');
        },
      },
    });
    expect((await call('get_incident', { incidentId: 'zzz' }, missing)).out.content).toContain('не найдено');
  });
});

describe('get_reference и get_playbook', () => {
  it('справочник: список тем без id, текст по id, подсказка по неверному id', async () => {
    const list = JSON.parse((await call('get_reference', {})).out.content) as Array<{ id: string }>;
    expect(list.length).toBeGreaterThan(0);
    const first = list[0]?.id ?? '';
    expect((await call('get_reference', { id: first })).out.content.length).toBeGreaterThan(20);
    expect((await call('get_reference', { id: 'нет' })).out.content).toContain('Доступные:');
  });
  it('плейбук: список без id, текст по id, подсказка по неверному id', async () => {
    const list = JSON.parse((await call('get_playbook', {})).out.content) as Array<{ id: string }>;
    expect(list.length).toBeGreaterThan(0);
    const first = list[0]?.id ?? '';
    expect((await call('get_playbook', { id: first })).out.content).toContain('ПЛЕЙБУК');
    expect((await call('get_playbook', { id: 'нет' })).out.content).toContain('Доступные:');
  });
});

it('чужое имя инструмента — null, чтобы отработал основной исполнитель', async () => {
  expect(await runReadTool('search_kb', {}, deps())).toBeNull();
});

describe('get_billing', () => {
  it('без биллинга — понятный ответ; с биллингом — оплаты целиком', async () => {
    const { out } = await call('get_billing', {});
    expect(out.content).toBe('Биллинг сейчас недоступен.');
    const forAssistant = vi.fn(async () => ({
      items: [{ title: 'DE-1', state: 'overdue', due: 'просрочено на 1 день' }],
      month: { spent: '0 ₽', expected: '468 ₽', payments: 0 },
      year: { spent: '0 ₽' },
      rates: null,
    }));
    const { json } = await call('get_billing', { archived: true }, deps({ billing: { forAssistant } }));
    expect(forAssistant).toHaveBeenCalledWith({ archived: true });
    expect(json().items[0].due).toBe('просрочено на 1 день');
  });
});
