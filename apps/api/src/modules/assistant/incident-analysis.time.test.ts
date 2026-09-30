import { ASSISTANT_PERMISSIONS_DEFAULT, type Incident, type IncidentAnalysis } from '@nodeservice/shared';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { IncidentAnalysisService } from './incident-analysis.service.js';
import type { LlmBlock, LlmResp, LlmRunInput } from './llm.provider.js';

const ID = '0192d000-0000-7000-8000-000000000002';
const ISO_STAMP = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

const textOf = (blocks: LlmBlock[] | undefined): string =>
  (blocks ?? [])
    .map((b) => (b.type === 'text' ? b.text : b.type === 'tool_result' ? b.content : ''))
    .join('\n');

/**
 * Служба разбора на заглушках: дело про CPU без сервера (улики по SSH и метрикам не собираются), пояс панели —
 * Омск. Модель сначала читает дело инструментом, потом сдаёт разбор.
 */
function setup(timeZone: (() => Promise<string>) | undefined) {
  const openedAt = '2026-09-30T09:56:03.000Z';
  const store: { inc: Incident } = {
    inc: {
      id: ID,
      serverId: null,
      serverName: 'de-fra-01',
      kind: 'cpu_high',
      severity: 'warn',
      status: 'open',
      title: 'Высокая загрузка CPU · de-fra-01',
      detail: 'CPU 96 % дольше 5 минут.',
      openedAt,
      resolvedAt: null,
      resolvedBy: null,
      timeline: [{ at: '2026-09-30T09:57:10.000Z', by: 'auto', action: 'Обнаружено', result: 'detect' }],
      attempts: [],
      proposal: null,
      snapshot: null,
      analysis: null,
    },
  };
  const seen: LlmRunInput[] = [];
  const incidents = {
    get: async () => structuredClone(store.inc),
    saveAnalysis: async (_id: string, a: IncidentAnalysis) => {
      store.inc.analysis = structuredClone(a);
      return true;
    },
    saveRunningAnalysis: async (_id: string, startedAt: string, a: IncidentAnalysis) => {
      const cur = store.inc.analysis;
      if (cur?.status !== 'running' || cur.startedAt !== startedAt) return false;
      store.inc.analysis = structuredClone(a);
      return true;
    },
  };
  const llm = async (input: LlmRunInput): Promise<LlmResp> => {
    seen.push(structuredClone({ ...input, signal: undefined }) as LlmRunInput);
    if (input.system.startsWith('ВОПРОС ПО РАЗБОРУ.'))
      return { stopReason: 'end', blocks: [{ type: 'text', text: 'Ответ.' }] };
    const asked = input.messages.some((m) => m.content.some((b) => b.type === 'tool_result'));
    return asked
      ? {
          stopReason: 'tool_use',
          blocks: [
            {
              type: 'tool_use',
              id: 't2',
              name: 'submit_analysis',
              input: {
                verdict: 'Процессор занят нодой.',
                confidence: 'medium',
                evidence: [{ source: 'metric', text: 'CPU 96 %.' }],
              },
            },
          ],
        }
      : {
          stopReason: 'tool_use',
          blocks: [{ type: 'tool_use', id: 't1', name: 'get_incident', input: { incidentId: ID } }],
        };
  };
  const svc = new IncidentAnalysisService(
    {
      config: async () => ({
        apiKey: 'k',
        provider: 'zveno',
        model: 'm',
        level: 'intermediate',
        permissions: { ...ASSISTANT_PERMISSIONS_DEFAULT },
      }),
    } as never,
    incidents as never,
    { get: (permissions: unknown) => ({ incidents, permissions }) } as never,
    { record: async () => undefined } as never,
    { fleetRules: async () => null } as never,
    { run: llm } as never,
    {} as never,
    {} as never,
    {} as never,
    { releaseAfterAnalysis: () => undefined, ...(timeZone ? { timeZone } : {}) } as never,
    {} as never,
    {} as never,
    {} as never,
  );
  const done = async () => {
    for (let i = 0; i < 100 && store.inc.analysis?.status === 'running'; i += 1)
      await new Promise((r) => setTimeout(r, 10));
    return store.inc.analysis;
  };
  return { svc, seen, done };
}

describe('время в разборе — в поясе панели', () => {
  // Часы зафиксированы: год в дате печатается, только если он не текущий, и без этого тест зависел бы от
  // настоящего года. Подменяется только Date — таймеры остаются настоящими.
  beforeAll(() => {
    vi.useFakeTimers({ now: new Date('2026-09-30T09:58:30Z'), toFake: ['Date'] });
  });
  afterAll(() => {
    vi.useRealTimers();
  });

  it('дело, ответы инструментов и вопросы по разбору приходят модели с временем панели, без отметок UTC', async () => {
    const { svc, seen, done } = setup(async () => 'Asia/Omsk');
    await svc.start(ID);
    expect((await done())?.status).toBe('done');

    const first = textOf(seen[0]?.messages[0]?.content);
    expect(first.startsWith('<данные>\nСейчас: 30 сентября 2026, 15:58 (UTC+6). Время в деле, уликах')).toBe(
      true,
    );
    // 09:56 UTC — это 15:56 в Омске: так же, как администратор видит в интерфейсе.
    expect(first).toContain('"openedAt":"30 сентября, 15:56:03"');
    expect(first).toContain('"at":"30 сентября, 15:57:10"');
    expect(first).not.toMatch(ISO_STAMP);

    // Ответ инструмента (дело целиком) — тоже во времени панели.
    const toolResult = textOf(seen[1]?.messages.at(-1)?.content);
    expect(toolResult).toContain('"openedAt":"30 сентября, 15:56:03"');
    expect(toolResult).not.toMatch(ISO_STAMP);

    await svc.ask(ID, 'Когда началось?');
    const ask = seen.at(-1);
    expect(ask?.system).toContain('ОКНО ОПЛАТЫ');
    const askData = textOf(ask?.messages[0]?.content);
    expect(askData).toContain('(UTC+6)');
    expect(askData).toContain('"openedAt":"30 сентября, 15:56:03"');
    expect(askData).not.toMatch(ISO_STAMP);
  });

  it('пояс панели узнать не удалось — время по Москве, разбор не падает', async () => {
    for (const tz of [
      undefined,
      async () => {
        throw new Error('настройки недоступны');
      },
      async () => 'Нет/Такого',
    ]) {
      const { svc, seen, done } = setup(tz);
      await svc.start(ID);
      expect((await done())?.status).toBe('done');
      const first = textOf(seen[0]?.messages[0]?.content);
      expect(first).toContain('(МСК)');
      expect(first).toContain('"openedAt":"30 сентября, 12:56:03"');
    }
  });
});
