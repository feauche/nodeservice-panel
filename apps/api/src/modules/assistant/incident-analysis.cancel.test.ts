import { ASSISTANT_PERMISSIONS_DEFAULT, type Incident, type IncidentAnalysis } from '@nodeservice/shared';
import { describe, expect, it } from 'vitest';

import { IncidentAnalysisService } from './incident-analysis.service.js';
import type { LlmResp, LlmRunInput } from './llm.provider.js';

const ID = '0192d000-0000-7000-8000-000000000001';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Служба разбора на заглушках: инцидент про CPU без сервера — улики по SSH и метрикам не собираются. */
function setup(llmRun: (input: LlmRunInput) => Promise<LlmResp>) {
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
      openedAt: new Date(Date.now() - 600_000).toISOString(),
      resolvedAt: null,
      resolvedBy: null,
      timeline: [],
      attempts: [],
      proposal: null,
      snapshot: null,
      analysis: null,
    },
  };
  const released: Array<[string, string | null]> = [];
  const audits: string[] = [];
  const incidents = {
    get: async () => structuredClone(store.inc),
    saveAnalysis: async (_id: string, a: IncidentAnalysis) => {
      store.inc.analysis = structuredClone(a);
      return true;
    },
    // Как в базе: ход разбора пишется, только пока в инциденте всё ещё этот же идущий разбор.
    saveRunningAnalysis: async (_id: string, startedAt: string, a: IncidentAnalysis) => {
      const cur = store.inc.analysis;
      if (cur?.status !== 'running' || cur.startedAt !== startedAt) return false;
      store.inc.analysis = structuredClone(a);
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
        permissions: { ...ASSISTANT_PERMISSIONS_DEFAULT },
      }),
    } as never,
    incidents as never,
    { get: () => ({}) } as never,
    { record: async (e: { action: string }) => void audits.push(e.action) } as never,
    { fleetRules: async () => null } as never,
    { run: llmRun } as never,
    {} as never,
    {} as never,
    {} as never,
    {
      releaseAfterAnalysis: (id: string, verdict: string | null) => void released.push([id, verdict]),
    } as never,
    {} as never,
    {} as never,
    {} as never,
    // Связь нод с серверами — в этих сценариях не нужна.
    {} as never,
    // Настройки окружения: адрес панели для подсказок Джарвиса.
    { get: () => 'https://panel.test' } as never,
  );
  return { svc, store, released, audits };
}

describe('отмена идущего разбора', () => {
  it('запрос к модели обрывается, в инциденте остаётся «отменён», разбор можно запустить заново', async () => {
    let aborted = 0;
    const { svc, store, released, audits } = setup(
      (input) =>
        new Promise((_, reject) => {
          input.signal?.addEventListener('abort', () => {
            aborted += 1;
            reject(new DOMException('This operation was aborted', 'AbortError'));
          });
        }),
    );
    expect((await svc.start(ID)).analysis?.status).toBe('running');
    await sleep(20);

    const after = await svc.cancel(ID);
    expect(after.analysis).toMatchObject({ status: 'cancelled', error: null });
    expect(after.analysis?.finishedAt).not.toBeNull();
    expect(after.analysis?.steps).toContain('Читаю снимок сигналов и хронологию');
    expect(aborted).toBe(1);

    // Оборванный запрос не превращает отмену в ошибку «Не удалось получить ответ Джарвиса».
    await sleep(30);
    expect(store.inc.analysis?.status).toBe('cancelled');
    // Сообщение в Telegram, которое ждало разбора, уходит как есть.
    expect(released).toContainEqual([ID, null]);
    expect(audits).toContain('incident.analysis.cancelled');

    expect((await svc.start(ID)).analysis?.status).toBe('running');
    await svc.cancel(ID);
  });

  it('модель ответила уже после отмены — вывод не затирает «отменён», новый разбор не ломается старым', async () => {
    const answers: Array<(r: LlmResp) => void> = [];
    // Эта «модель» отмену не замечает — как долгая проверка по SSH, которую не оборвать.
    const { svc, store } = setup(() => new Promise((resolve) => void answers.push(resolve)));
    await svc.start(ID);
    await sleep(20);
    await svc.cancel(ID);
    // Отменённый разбор не держит инцидент занятым: новый стартует сразу.
    const again = await svc.start(ID);
    const startedAt = again.analysis?.startedAt;
    await sleep(20);
    answers[0]?.({
      stopReason: 'tool_use',
      blocks: [{ type: 'tool_use', id: 't1', name: 'submit_analysis', input: { verdict: 'Поздний вывод.' } }],
    });
    await sleep(30);
    expect(store.inc.analysis).toMatchObject({ status: 'running', startedAt, verdict: null });
    await svc.cancel(ID);
    expect(store.inc.analysis?.status).toBe('cancelled');
  });

  it('отменять нечего — понятный отказ', async () => {
    const { svc } = setup(async () => ({ stopReason: 'end', blocks: [] }));
    await expect(svc.cancel(ID)).rejects.toMatchObject({ status: 409 });
  });
});
