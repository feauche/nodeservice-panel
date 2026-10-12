import { CSRF_HEADER, type IncidentAnalysis, incidentSchema } from '@nodeservice/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { currentIncidentApp } from './current-incidents.fixture.js';

describe('удалённый автоматический разбор и сохранённая история (e2e)', () => {
  let ctx: Awaited<ReturnType<typeof currentIncidentApp>>;
  beforeAll(async () => {
    ctx = await currentIncidentApp();
  });
  afterAll(async () => {
    await ctx?.app.close();
  });
  it('старый завершённый разбор сохраняется в detail и не вызывает LLM при открытии', async () => {
    const row = await ctx.seed();
    const analysis: IncidentAnalysis = {
      status: 'done',
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      steps: ['Исторический разбор'],
      verdict: 'Сохранённый вывод',
      confidence: 'medium',
      evidence: [],
      unknown: null,
      nextAction: null,
      basedOn: { attempts: 0, resolved: false },
      model: 'legacy-model',
      error: null,
      thread: [{ question: 'Старый вопрос', answer: 'Старый ответ', at: new Date().toISOString() }],
    };
    await ctx.repo.update(row.id, { analysis });
    const detail = incidentSchema.parse((await ctx.agent.get(`/api/incidents/${row.id}`).expect(200)).body);
    expect(detail.analysis).toEqual(analysis);
    expect(ctx.llm.run).not.toHaveBeenCalled();
  });
  it('анализ/вопрос/отмена HTTP пути удалены; automatic analysis provider не регистрируется', async () => {
    const row = await ctx.seed();
    for (const action of ['analyze', 'analysis/ask', 'analysis/cancel'])
      await ctx.agent
        .post(`/api/incidents/${row.id}/${action}`)
        .set(CSRF_HEADER, ctx.csrf)
        .send({ question: 'Что произошло?' })
        .expect(404);
    expect(ctx.llm.run).not.toHaveBeenCalled();
    expect(ctx.ssh.connect).not.toHaveBeenCalled();
  });
});
