import { ASSISTANT_PERMISSIONS_DEFAULT, type Incident, type IncidentAnalysis } from '@nodeservice/shared';
import { describe, expect, it } from 'vitest';

import { AUTO_ANALYSIS_PER_HOUR } from './incident-analysis.logic.js';
import { IncidentAnalysisService } from './incident-analysis.service.js';
import type { LlmResp, LlmRunInput } from './llm.provider.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const idOf = (n: number) => `0192d000-0000-7000-8000-0000000000${String(n).padStart(2, '0')}`;

const incident = (n: number): Incident => ({
  id: idOf(n),
  serverId: null,
  serverName: `srv-${n}`,
  kind: 'cpu_high',
  severity: 'warn',
  status: 'open',
  title: `Высокая загрузка CPU · srv-${n}`,
  detail: 'CPU 96 % дольше 5 минут.',
  // Старше паузы автопочинки, чем меньше номер — тем старше: автоматический разбор берёт старшие первыми.
  openedAt: new Date(Date.now() - 600_000 + n * 1000).toISOString(),
  resolvedAt: null,
  resolvedBy: null,
  timeline: [],
  attempts: [],
  proposal: null,
  snapshot: null,
  analysis: null,
});

/** Служба разбора на заглушках: дела про CPU без сервера — улики по SSH и метрикам не собираются. */
function setup(count: number, llmRun: (input: LlmRunInput) => Promise<LlmResp>) {
  const store = new Map<string, Incident>();
  for (let n = 1; n <= count; n += 1) store.set(idOf(n), incident(n));
  const released: Array<[string, string | null]> = [];
  const broken = new Set<string>();
  const incidents = {
    autoAnalysisRoom: (() => 1) as () => number,
    failRunningAnalyses: async () => 0,
    list: async () => ({ items: [...store.values()].map((i) => structuredClone(i)) }),
    get: async (id: string) => {
      if (broken.has(id)) throw new Error('дело не читается');
      return structuredClone(store.get(id) as Incident);
    },
    saveAnalysis: async (id: string, a: IncidentAnalysis) => {
      (store.get(id) as Incident).analysis = structuredClone(a);
      return true;
    },
    saveRunningAnalysis: async (id: string, startedAt: string, a: IncidentAnalysis) => {
      const cur = store.get(id)?.analysis;
      if (cur?.status !== 'running' || cur.startedAt !== startedAt) return false;
      (store.get(id) as Incident).analysis = structuredClone(a);
      return true;
    },
  };
  const svc = new IncidentAnalysisService(
    {
      config: async () => ({
        apiKey: 'k',
        provider: 'zveno',
        model: 'm',
        level: 'intermediate',
        permissions: { ...ASSISTANT_PERMISSIONS_DEFAULT, autoAnalysis: true },
      }),
    } as never,
    incidents as never,
    { get: () => ({}) } as never,
    { record: async () => undefined } as never,
    { fleetRules: async () => null } as never,
    { run: llmRun } as never,
    {} as never,
    {} as never,
    {} as never,
    {
      releaseAfterAnalysis: async (id: string, verdict: string | null) => void released.push([id, verdict]),
    } as never,
    {} as never,
    {} as never,
    {} as never,
  );
  return { svc, store, released, incidents, broken };
}

/** Модель, которая не отвечает, пока разбор не отменят. */
const hangs = (input: LlmRunInput): Promise<LlmResp> =>
  new Promise((_, reject) => {
    input.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
  });

describe('сообщение в Telegram не ждёт разбора, которого не будет', () => {
  it('лимит автоматических разборов в час исчерпан — остальные дела отпускаются без вывода; новым делам ждать нечего', async () => {
    const { svc, released, incidents } = setup(AUTO_ANALYSIS_PER_HOUR + 2, hangs);
    await svc.onModuleInit();
    // Служба разбора сама сообщает «Инцидентам», сколько разборов ещё можно начать в этот час.
    expect(incidents.autoAnalysisRoom()).toBe(AUTO_ANALYSIS_PER_HOUR);

    const started = await svc.autoRun();
    expect(started).toHaveLength(AUTO_ANALYSIS_PER_HOUR);
    expect(incidents.autoAnalysisRoom()).toBe(0);
    // Двум самым новым делам разбора в этот час не достанется — их сообщения уходят как есть.
    expect(released.sort()).toEqual([
      [idOf(AUTO_ANALYSIS_PER_HOUR + 1), null],
      [idOf(AUTO_ANALYSIS_PER_HOUR + 2), null],
    ]);
    for (const id of started) await svc.cancel(id);
  });

  it('разбор не запустился — сообщение по этому делу уходит как есть, а не ждёт до конца', async () => {
    const { svc, released, broken } = setup(2, hangs);
    broken.add(idOf(1));
    const started = await svc.autoRun();
    expect(started).toEqual([idOf(2)]);
    expect(released).toEqual([[idOf(1), null]]);
    await svc.cancel(idOf(2));
  });

  it('разбор оборван, потому что дело уточнили, — отложенное сообщение ждёт нового разбора, а не уходит без вывода', async () => {
    const answers: Array<(r: LlmResp) => void> = [];
    const { svc, store, released } = setup(1, () => new Promise((resolve) => void answers.push(resolve)));
    await svc.start(idOf(1));
    await sleep(20);
    // «Агент не в сети» уточнили до «Сервер недоступен»: прежний разбор сброшен, по делу ждёт новое сообщение.
    (store.get(idOf(1)) as Incident).analysis = null;
    answers[0]?.({
      stopReason: 'tool_use',
      blocks: [
        {
          type: 'tool_use',
          id: 't1',
          name: 'submit_analysis',
          input: {
            verdict: 'Вывод по старому делу.',
            confidence: 'low',
            evidence: [{ source: 'metric', text: 'x' }],
          },
        },
      ],
    });
    await sleep(30);
    expect(released).toEqual([]);
  });

  it('разбор не получился — сообщение уходит как есть, один раз', async () => {
    const { svc, store, released } = setup(1, async () => {
      throw new Error('zveno.ai ответил 401: bad key');
    });
    await svc.start(idOf(1));
    await sleep(30);
    expect(store.get(idOf(1))?.analysis?.status).toBe('failed');
    expect(released).toEqual([[idOf(1), null]]);
  });
});
